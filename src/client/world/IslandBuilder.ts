/**
 * Builds every island-scale mesh: the island terrain groups and their decoration,
 * the server prop registry instancing, sea-stack rocks and the story NPC props.
 *
 * State that the rest of Game still reads each frame (mesh registries, foliage
 * wind uniforms, the environment group) is handed in by reference through
 * `IslandBuilderCtx` rather than duplicated here, so this extraction stays
 * behaviour-neutral.
 */
import * as THREE from 'three';
import type { Island, IslandNpc, IslandProp, IslandPropType, SeaRock } from '../../shared/types/index.js';
import { assets, type AssetName } from '../assets/AssetLibrary.js';
import { BIOME_PALETTES, getPropGroundY } from '../../shared/props.js';
import { getIslandMaxRadius, getIslandSurfacePoint, getIslandSurfaceY, geyserEruptionLevel, isPointInsideIslandFootprint } from '../../shared/utils/index.js';
import { applyCaveTubeColors, cullCaveTubeAgainstNeighbors, makeCaveTubeGeometry } from '../rendering/factories/CaveGeometry.js';
import { makeFernFrondTexture, makeGrassBladeTexture, makeUpgradeSignTexture } from '../rendering/factories/TextureFactory.js';
import { makeUpgradeStationProp } from '../rendering/factories/MiscMeshFactory.js';
import { makePlayerMesh } from '../rendering/factories/PlayerMeshFactory.js';
import type { IslandBuildCtx, IslandBuilderCtx, NpcMeshRecord } from './island/context.js';
import { makeCaveMouthCarver } from './island/CaveBuilder.js';
import { buildProxyTerrainMesh, buildTerrainMesh } from './island/TerrainMeshBuilder.js';

export type { ChestMeshRecord, NpcMeshRecord, UpgradeStationMeshRecord } from './island/context.js';

/** Instanced prop types that bend in the wind (palms + soft foliage; not rocks). */
const SWAYING_FOLIAGE: ReadonlySet<string> = new Set([
  'palm_a', 'palm_b', 'palm_c', 'palm_tall', 'palm_ground',
  'fern_plant', 'bush', 'bush_berry', 'flower_bush', 'wildflowers', 'flower_patch',
]);

/**
 * Instance-scale rails for the scattered ground cover, per type.
 *
 * Scatter scales used to be free-running `base + rand * span` draws (and, for
 * grass height, TWO of those multiplied together). Compounded draws have a much
 * longer tail than they look on the page: grass blades ran 0.55x..2.39x, a 4.3x
 * spread, so two blades in the SAME tuft could differ more than fourfold — the
 * outliers read as stray giant cards standing over the lawn. Every scatter draws
 * inside (and is clamped to) its rails, which keeps any two instances of a type
 * within ~2.2x of each other while leaving the median size where it was.
 */
const FLORA_SCALE = {
  grass: { min: 0.78, max: 1.52 },
  /** Composed height (uniform scale × height factor) — its own, slightly wider rail. */
  grassHeight: { min: 0.80, max: 1.75 },
  fern: { min: 0.68, max: 1.38 },
  shell: { min: 0.78, max: 1.55 },
} as const;

type FloraScaleRange = { readonly min: number; readonly max: number };

/** Map a 0..1 deterministic draw onto a type's scale rail. */
function floraScale(rand01: number, range: FloraScaleRange): number {
  return range.min + rand01 * (range.max - range.min);
}

/** Hold a composed (multiplied) scale to its type's rail. */
function clampFloraScale(value: number, range: FloraScaleRange): number {
  return value < range.min ? range.min : value > range.max ? range.max : value;
}

export class IslandBuilder {
  constructor(private readonly ctx: IslandBuilderCtx) {}

  private seaRockMaterialCache: THREE.MeshStandardMaterial | null = null;
  /** Shared enriched sea-stack material: the Blender GLB gives the eroded pillar
   *  geometry, this paints it with sedimentary strata bands, a wet dark base at
   *  the waterline, a sun-bleached crown and position mottling so stacks read as
   *  real weathered rock — not flat pale monoliths. Keyed on local/world pos so a
   *  single shared material still varies per rock. */
  getSeaRockMaterial(): THREE.MeshStandardMaterial {
    if (this.seaRockMaterialCache) return this.seaRockMaterialCache;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRockWorld;\nvarying float vRockLocalY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockLocalY = position.y;\nvRockWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRockWorld;\nvarying float vRockLocalY;')
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n'
          + 'float _band = sin(vRockLocalY * 1.35 + 0.6) * 0.5 + 0.5;\n'
          + '_band = pow(_band, 1.4);\n'                                    // crisper band edges
          + 'vec3 _rockA = vec3(0.20, 0.185, 0.16);\n'                      // dark weathered stone
          + 'vec3 _rockB = vec3(0.40, 0.36, 0.30);\n'                       // warm lit band
          + 'vec3 _col = mix(_rockA, _rockB, _band);\n'
          + '_col *= 0.88 + 0.12 * sin(vRockLocalY * 5.0 + 1.3);\n'
          + 'float _m = fract(sin(dot(floor(vRockWorld.xz * 0.55), vec2(12.9898, 78.233))) * 43758.5453);\n'
          + '_col *= 0.86 + 0.2 * _m;\n'
          + 'float _wet = 1.0 - smoothstep(-1.0, 5.5, vRockWorld.y);\n'
          + '_col = mix(_col, vec3(0.11, 0.13, 0.14), _wet * 0.75);\n'      // dark salt-wet base
          + 'float _crown = smoothstep(7.0, 12.5, vRockLocalY);\n'
          + '_col = mix(_col, vec3(0.55, 0.53, 0.47), _crown * 0.55);\n'    // sun-bleached / guano crown
          + '_col += vec3(0.03, 0.045, 0.02) * (1.0 - _band) * (1.0 - _wet);\n' // faint lichen in shaded bands

          + 'diffuseColor.rgb = _col;',
        );
    };
    mat.customProgramCacheKey = () => 'pirates-searock';
    this.seaRockMaterialCache = mat;
    return mat;
  }

  buildSeaRockMesh(rock: SeaRock) {
    const group = new THREE.Group();
    group.name = `sea-rock-${rock.id}`;
    group.position.set(rock.position.x, rock.position.y, rock.position.z);
    group.rotation.y = rock.rotation;
    const lowDetail = this.ctx.renderer.getQuality() === 'low';

    // GLB sea spires by size tier, fitted inside the server collider envelope
    // (main collider cylinder) so visuals never exceed the collision size.
    const tier: AssetName = rock.height > 26 ? 'searock_b' : rock.height > 13 ? 'searock_a' : 'searock_c';
    const rockClone = assets.clone(tier);
    const rockBounds = assets.bounds(tier);
    if (rockClone && rockBounds) {
      const assetHoriz = Math.max(-rockBounds.min.x, rockBounds.max.x, -rockBounds.min.z, rockBounds.max.z, 0.001);
      const mainColliderRadius = rock.variant === 1 ? rock.radius * 0.72 : rock.radius * (0.62 + rock.variant * 0.035);
      const mainColliderTop = rock.height * (rock.variant === 1 ? 0.84 : 0.94) - 1.3;
      const sxz = mainColliderRadius / assetHoriz;
      const sy = Math.max(0.4, mainColliderTop / Math.max(rockBounds.max.y, 0.001));
      rockClone.scale.set(sxz, sy, sxz);
      const seaRockMat = this.getSeaRockMaterial();
      rockClone.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.material = seaRockMat;          // enriched strata/wet/mottle look
          o.castShadow = !lowDetail;
          o.receiveShadow = !lowDetail;
        }
      });
      group.add(rockClone);

      const foam = new THREE.Mesh(
        new THREE.RingGeometry(rock.radius * 0.8, rock.radius * 1.12, lowDetail ? 12 : 24),
        new THREE.MeshBasicMaterial({ color: 0xdcede8, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false }),
      );
      foam.rotation.x = -Math.PI * 0.5;
      foam.position.y = 0.04;
      group.add(foam);
      return group;
    }

    const darkMat = new THREE.MeshStandardMaterial({ color: 0x292d2b, roughness: 1, flatShading: true });
    const wetMat = new THREE.MeshStandardMaterial({ color: 0x3c403a, roughness: 0.92, flatShading: true });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x595548, roughness: 0.98, flatShading: true });
    const mainGeo = rock.variant === 1
      ? new THREE.ConeGeometry(rock.radius * 0.72, rock.height, 6, 1)
      : new THREE.DodecahedronGeometry(rock.radius * 0.62, 1);
    const main = new THREE.Mesh(mainGeo, rock.variant === 2 ? wetMat : darkMat);
    main.scale.set(1.05, rock.variant === 1 ? 1 : rock.height / Math.max(1, rock.radius), 0.82 + rock.variant * 0.08);
    main.position.y = rock.height * 0.34 - 1.8;
    main.rotation.set(-0.16 + rock.variant * 0.11, 0, 0.09);
    main.castShadow = !lowDetail;
    main.receiveShadow = !lowDetail;
    group.add(main);

    const shardCount = lowDetail ? 1 + Math.min(1, rock.variant) : 4 + rock.variant;
    for (let i = 0; i < shardCount; i++) {
      const angle = (i / shardCount) * Math.PI * 2 + rock.rotation * 0.17;
      const radius = rock.radius * (0.28 + (i % 2) * 0.16);
      const shardH = rock.height * (0.34 + (i % 3) * 0.08);
      const shard = new THREE.Mesh(
        new THREE.ConeGeometry(rock.radius * (0.16 + (i % 2) * 0.04), shardH, 5, 1),
        i % 2 === 0 ? wetMat : topMat,
      );
      shard.position.set(Math.cos(angle) * radius, shardH * 0.28 - 1.2, Math.sin(angle) * radius);
      shard.rotation.set((i % 2 ? 0.24 : -0.18), angle, (i % 3 - 1) * 0.18);
      shard.castShadow = !lowDetail;
      shard.receiveShadow = !lowDetail;
      group.add(shard);
    }

    const foam = new THREE.Mesh(
      new THREE.RingGeometry(rock.radius * 0.8, rock.radius * 1.12, lowDetail ? 12 : 24),
      new THREE.MeshBasicMaterial({ color: 0xdcede8, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false }),
    );
    foam.rotation.x = -Math.PI * 0.5;
    foam.position.y = 0.04;
    group.add(foam);

    return group;
  }

  /**
   * Clone a GLB library prop and place it. Returns null when the asset failed
   * to load (callers keep their procedural fallback). Kept signature-stable so
   * a later server-driven prop registry can reuse it.
   */
  buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale = 1): THREE.Group | null {
    const clone = assets.clone(type);
    if (!clone) return null;
    clone.position.copy(position);
    clone.rotation.y = yaw;
    clone.scale.setScalar(scale);
    return clone;
  }

  /** Render the SERVER's deterministic prop registry (island.props) — the same
   *  registry PhysicsSystem collides against every tick. Before this, the
   *  client scattered its own decorative palms/boulders while the real
   *  colliders stayed invisible: players got shoved by nothing and walked
   *  through every visible tree. Rendering the registry makes visuals ==
   *  colliders, and finally shows the roster landmarks (watchtowers, standing
   *  stones, wrecks) that were generated but never drawn. */
  /** Inject a vertex wind-sway into an instanced foliage material: higher parts
   *  bend more, each instance offset by its world position so a grove ripples
   *  rather than swaying in lockstep. Applied once per shared material. */
  applyFoliageSway(material: THREE.Material | THREE.Material[]) {
    if (Array.isArray(material)) {
      for (const m of material) this.applyFoliageSway(m);
      return;
    }
    const ud = material.userData as { swayApplied?: boolean };
    if (ud.swayApplied) return;
    ud.swayApplied = true;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFoliageTime = this.ctx.foliageTime;
      shader.uniforms.uFoliageWind = this.ctx.foliageWind;
      shader.vertexShader = 'uniform float uFoliageTime;\nuniform vec2 uFoliageWind;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         // Guarded: these materials are SHARED with non-instanced clones of the
         // same GLB (assets.clone → harvest promote/topple actors). three.js only
         // declares instanceMatrix under USE_INSTANCING, so an unguarded read
         // fails shader compilation and the clone silently renders NOTHING —
         // the "tree vanishes while chopping" bug.
         #ifdef USE_INSTANCING
         float swayH = max(0.0, transformed.y - 0.6) * 0.06;   // bend the crown, not the trunk base
         vec3 iPos = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
         float ph = iPos.x * 0.13 + iPos.z * 0.11;
         float s = sin(uFoliageTime * 1.5 + ph) + 0.35 * sin(uFoliageTime * 3.2 + ph * 1.7);
         transformed.x += swayH * uFoliageWind.x * s;
         transformed.z += swayH * uFoliageWind.y * s;
         #endif`,
      );
    };
    material.needsUpdate = true;
  }

  /** Story-scene ground pads (`Sand_Pad` / `Grave_Dirt` in the scene GLBs) were
   *  stamping hard white or dark ellipses onto the terrain — "paint splats" in
   *  the tour audit. Give each pad its own material tinted 55% toward the host
   *  island's ground palette, mottled with the same world-space noise the
   *  terrain uses, and eroded at the rim by an alpha-tested noise threshold so
   *  the edge crumbles into the ground instead of ending on a clean arc.
   *  (`discard` rather than blending: a transparent ground decal sorts badly
   *  against every prop standing on it.) */
  private blendStoryPad(mesh: THREE.Mesh, island: Island) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!mats.some((m) => m && (m.name === 'Sand_Pad' || m.name === 'Grave_Dirt'))) return;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const padR = Math.max(0.5, mesh.geometry.boundingSphere?.radius ?? 1);
    const palette = BIOME_PALETTES[island.profile.biome ?? 'lush'];
    // Sand-DOMINANT blend: the audit flagged both failure modes (stark white
    // discs AND dark olive stains), so the pad must land lighter than the turf,
    // never darker.
    const ground = new THREE.Color(palette.sand).lerp(new THREE.Color(palette.grass), 0.3);
    const dressed = mats.map((m) => {
      if (!m || (m.name !== 'Sand_Pad' && m.name !== 'Grave_Dirt') || !(m instanceof THREE.MeshStandardMaterial)) return m;
      const clone = m.clone();
      clone.color.lerp(ground, 0.55);
      clone.onBeforeCompile = (shader) => {
        shader.uniforms.uPadR = { value: padR };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vPadWorld;\nvarying vec2 vPadLocal;')
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvPadLocal = transformed.xz;\nvPadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform float uPadR;\nvarying vec3 vPadWorld;\nvarying vec2 vPadLocal;\n'
            + 'float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n'
            + 'float pNoise(vec2 p) {\n'
            + '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);\n'
            + '  return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), u.x),\n'
            + '             mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), u.x), u.y);\n'
            + '}\n',
          )
          .replace(
            '#include <color_fragment>',
            '#include <color_fragment>\n'
            + 'float padN = pNoise(vPadWorld.xz * 1.6) * 0.6 + pNoise(vPadWorld.xz * 5.5) * 0.4;\n'
            + 'float padEdge = length(vPadLocal) / uPadR;\n'
            + 'if (padEdge > 0.55 && padN < smoothstep(0.58, 1.0, padEdge) * 0.9) discard;\n'
            + 'diffuseColor.rgb *= 0.86 + padN * 0.30;\n',
          );
      };
      clone.customProgramCacheKey = () => 'pirates-story-pad';
      return clone;
    });
    mesh.material = Array.isArray(mesh.material) ? dressed as THREE.Material[] : dressed[0] as THREE.Material;
  }

  buildServerProps(island: Island, group: THREE.Group, lowDetail: boolean) {
    const props = island.props ?? [];
    if (props.length === 0) return;
    const propSlots = new Map<number, { inst: THREE.InstancedMesh; index: number }>();
    this.ctx.islandPropInstances.set(island.id, propSlots);
    const instancedTypes: ReadonlySet<string> = new Set([
      'palm_a', 'palm_b', 'palm_c', 'palm_tall', 'palm_ground',
      'boulder_a', 'boulder_b', 'boulder_c', 'barrel', 'crate',
      'bush', 'bush_berry', 'flower_bush', 'fern_plant', 'flower_patch', 'wildflowers',
      'bone_pile', 'driftwood_log', 'grave_marker',
    ]);
    const buckets = new Map<IslandPropType, IslandProp[]>();
    for (const prop of props) {
      // Dock modules are collider-only entries; the dock is drawn from island.dock.
      if (prop.type === 'dock_mid' || prop.type === 'dock_end') continue;
      const list = buckets.get(prop.type);
      if (list) list.push(prop);
      else buckets.set(prop.type, [prop]);
    }
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scl = new THREE.Vector3();
    for (const [type, list] of buckets) {
      const merged = instancedTypes.has(type) ? assets.mergedGeometry(type as AssetName) : null;
      if (merged) {
        if (SWAYING_FOLIAGE.has(type)) this.applyFoliageSway(merged.material);
        const inst = new THREE.InstancedMesh(merged.geometry, merged.material, list.length);
        list.forEach((prop, i) => {
          pos.set(prop.x - island.position.x, getPropGroundY(island, prop), prop.z - island.position.z);
          euler.set(0, prop.yaw, 0);
          quat.setFromEuler(euler);
          scl.setScalar(prop.scale);
          mat4.compose(pos, quat, scl);
          inst.setMatrixAt(i, mat4);
          if (prop.id !== undefined) propSlots.set(prop.id, { inst, index: i });
        });
        inst.castShadow = !lowDetail;
        inst.receiveShadow = true;
        inst.instanceMatrix.needsUpdate = true;
        group.add(inst);
        continue;
      }
      for (const prop of list) {
        const localPos = new THREE.Vector3(
          prop.x - island.position.x,
          getPropGroundY(island, prop),
          prop.z - island.position.z,
        );
        const node = this.buildPropInstance(prop.type as AssetName, localPos, prop.yaw, prop.scale);
        if (!node) continue;
        node.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = !lowDetail;
            obj.receiveShadow = true;
            this.blendStoryPad(obj, island);
          }
        });
        group.add(node);
        if (prop.type === 'campfire') {
          this.ctx.registerLanternEmitter(group, localPos.x, localPos.y + 0.4, localPos.z, 'campfire');
        } else if (prop.type === 'lantern_post') {
          this.ctx.registerLanternEmitter(group, localPos.x, localPos.y + 2.1, localPos.z, 'lantern');
        } else if (prop.type === 'widow_memorial') {
          // The widow's kept flame — must read from the sea at night.
          this.ctx.registerLanternEmitter(group, localPos.x, localPos.y + 3.0, localPos.z, 'lantern');
        } else if (prop.type === 'mermaid_shrine') {
          // Offering candles at the throne's base.
          this.ctx.registerLanternEmitter(group, localPos.x, localPos.y + 0.7, localPos.z, 'campfire');
        }
      }
    }
  }

  buildIsland(island: Island) {
    const group = new THREE.Group();
    group.name = `island-${island.name}`;
    group.position.set(island.position.x, island.position.y, island.position.z);

    const r = island.radius;
    const {
      islandHeading,
      footprintX,
      footprintZ,
    } = island.profile;
    const islandSeed = island.id.split('').reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
    const rng = (seed: number) => {
      const value = Math.sin(seed * 127.13 + islandSeed * 0.173 + r * 0.021) * 43758.5453;
      return value - Math.floor(value);
    };
    const visualDetail = this.ctx.renderer.getEffectScale();
    const lowDetail = visualDetail < 0.55;
    const scaledCount = (base: number, min: number) => {
      const scale = lowDetail ? visualDetail * 0.28 : visualDetail;
      const floor = lowDetail ? 0 : min;
      return Math.max(floor, Math.round(base * scale));
    };

    const reefMat = new THREE.MeshStandardMaterial({ color: 0x4d4a42, roughness: 1, side: THREE.DoubleSide });
    const cliffMat = new THREE.MeshStandardMaterial({ color: 0x564f3f, roughness: 0.98, side: THREE.DoubleSide });
    // Biome palette drives per-island vertex + foliage colors so a volcanic isle
    // reads dark and ashen while a lush one reads verdant and a bone atoll reads
    // pale. MapGenerator copies profile.palette from BIOME_PALETTES; fall back to
    // the biome table (then lush) if a profile predates the palette field.
    const palette = island.profile.palette
      ?? BIOME_PALETTES[island.profile.biome ?? 'lush']
      ?? BIOME_PALETTES.lush;
    const paletteSand = new THREE.Color(palette.sand);
    const paletteGrass = new THREE.Color(palette.grass);
    const paletteRock = new THREE.Color(palette.rock);
    const paletteFoliage = new THREE.Color(palette.foliage);
    // Only 5 biome palettes drive 14 islands, so same-biome neighbours looked
    // identical from the air. Nudge each island's greens by a seeded hue/sat
    // shift (deterministic from its id) so the archipelago reads varied.
    let _hueH = 2166136261;
    for (let ci = 0; ci < island.id.length; ci++) { _hueH ^= island.id.charCodeAt(ci); _hueH = Math.imul(_hueH, 16777619); }
    const hueSeed = ((_hueH >>> 0) % 1000) / 1000;
    const _hsl = { h: 0, s: 0, l: 0 };
    const nudgeGreen = (c: THREE.Color) => {
      c.getHSL(_hsl);
      c.setHSL((_hsl.h + (hueSeed - 0.5) * 0.05 + 1) % 1, Math.min(1, _hsl.s * (0.9 + hueSeed * 0.28)), _hsl.l * (0.94 + hueSeed * 0.12));
      return c;
    };
    nudgeGreen(paletteGrass);
    nudgeGreen(paletteFoliage);
    // Beach sand read as a flat near-white halo ringing sunlit islands
    // (patrol-3): pull the whitening way back and warm/darken the base so it's
    // sand, not a bloom band.
    // Postcard isles (profile.whiteSand) get bright white-sand beaches; the rest
    // keep their muted biome tan. A warm off-white (not pure white) so the berm
    // reads as brilliant sand without blowing out into a bloom halo.
    const whiteSand = !!island.profile.whiteSand;
    // A warm bone-white, not paper-white: postcard beaches should read as bright
    // sand, not a snow/ice shelf that blows out (worst on the atoll's shallows).
    const sandWhite = new THREE.Color(0xece0c4);
    const beachColor = whiteSand
      ? paletteSand.clone().lerp(sandWhite, 0.6)
      : paletteSand.clone().lerp(new THREE.Color(0xffffff), 0.05);
    const sandColor = whiteSand
      ? paletteSand.clone().lerp(sandWhite, 0.42)
      : paletteSand.clone().multiplyScalar(0.94).lerp(new THREE.Color(0xe4c88f), 0.16); // warm golden berm
    // Lush, sunlit greens: lift the base grass a touch for vibrancy, and blend
    // the (dark) foliage toward grass so jungle interiors read as rich green —
    // not a murky near-black blanket under the raised sky fill.
    const grassColor = paletteGrass.clone().multiplyScalar(1.12);
    const jungleColor = paletteFoliage.clone().lerp(paletteGrass, 0.4);
    const peakColor = paletteGrass.clone().lerp(paletteRock, 0.42);
    const cliffColor = paletteRock.clone().lerp(new THREE.Color(0xffffff), 0.06);
    const mudColor = paletteRock.clone().lerp(paletteFoliage, 0.3);
    const boulderMat = new THREE.MeshStandardMaterial({ color: paletteRock.clone().lerp(new THREE.Color(0xffffff), 0.08).getHex(), roughness: 1 });
    const driftwoodMat = new THREE.MeshStandardMaterial({ color: 0xc4b08a, roughness: 1 });
    const bambooMat = new THREE.MeshStandardMaterial({ color: 0x72b040, roughness: 0.8 });
    const shrineMat = new THREE.MeshStandardMaterial({ color: 0x625846, roughness: 1 });
    const boulderGeo = new THREE.DodecahedronGeometry(0.9, 0);
    const bambooGeo = new THREE.CylinderGeometry(0.05, 0.075, 1, 5);

    const createLayer = (config: {
      topRadius: number;
      bottomRadius: number;
      height: number;
      y: number;
      material: THREE.Material;
      radialSegments?: number;
      heightSegments?: number;
      scaleX?: number;
      scaleZ?: number;
      massOffsetX?: number;
      massOffsetZ?: number;
      shelf?: number;
      cliff?: number;
      cap?: number;
      jagged?: number;
      lean?: number;
    }) => {
      const tr = Math.max(0.01, Number.isFinite(config.topRadius) ? config.topRadius : 0.01);
      const br = Math.max(0.01, Number.isFinite(config.bottomRadius) ? config.bottomRadius : 0.01);
      const h = Math.max(0.01, Number.isFinite(config.height) ? config.height : 0.01);
      const geometry = new THREE.CylinderGeometry(
        tr,
        br,
        h,
        Math.max(3, Math.floor((config.radialSegments ?? 24) * visualDetail)),
        Math.max(1, Math.floor((config.heightSegments ?? 5) * (lowDetail ? 0.6 : visualDetail))),
      );
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const vertex = new THREE.Vector3();

      for (let index = 0; index < position.count; index++) {
        vertex.fromBufferAttribute(position, index);
        const angle = Math.atan2(vertex.z, vertex.x);
        const baseRadius = Math.hypot(vertex.x, vertex.z);
        // Clamp: rounding can put the top row at 1.0000000000000002, and
        // Math.pow(1 - y01, 1.35) with a negative base is NaN — which
        // silently corrupted the reef layer on 3 of 14 islands.
        const y01 = THREE.MathUtils.clamp((vertex.y + h * 0.5) / h, 0, 1);
        const lobeA = Math.sin(angle * 2 + islandHeading + y01 * 0.7) * 0.14;
        const lobeB = Math.sin(angle * 3 - islandHeading * 1.8 + y01 * 1.9) * 0.09;
        const lobeC = Math.cos(angle * 5 + islandHeading * 0.6 - y01 * 2.7) * 0.04;
        const shelf = Math.exp(-Math.pow((y01 - 0.18) / 0.17, 2)) * (config.shelf ?? 0.08);
        const cliff = Math.pow(1 - y01, 1.35) * (config.cliff ?? 0.1);
        const cap = Math.pow(y01, 1.8) * (config.cap ?? 0.05);
        const asymmetry = Math.cos(angle - islandHeading) * 0.08 + Math.sin(angle * 0.5 + islandHeading * 0.7) * 0.04;
        const jagged = (
          Math.sin(angle * 11 + y01 * 9 + islandHeading) +
          Math.cos(angle * 17 - y01 * 12 + islandHeading * 0.4)
        ) * (config.jagged ?? 0.015);
        const radialScale = 1 + lobeA + lobeB + lobeC + shelf + cliff - cap + asymmetry + jagged;
        const drift = (y01 - 0.5) * (config.lean ?? 0.02) * h;
        if (baseRadius > 0.0001) {
          vertex.x = Math.cos(angle) * baseRadius * radialScale * (config.scaleX ?? 1) + (config.massOffsetX ?? 0) + Math.cos(islandHeading) * drift;
          vertex.z = Math.sin(angle) * baseRadius * radialScale * (config.scaleZ ?? 1) + (config.massOffsetZ ?? 0) + Math.sin(islandHeading) * drift;
          vertex.y += (lobeA * 0.06 + lobeB * 0.04) * h * (0.3 + y01);
        } else {
          vertex.x += (config.massOffsetX ?? 0);
          vertex.z += (config.massOffsetZ ?? 0);
        }
        position.setXYZ(index, vertex.x, vertex.y, vertex.z);
      }

      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, config.material);
      mesh.position.y = Number.isFinite(config.y) ? config.y : 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    const surfacePoint = (distRatio: number, angle: number, extraY = 0) => {
      const point = getIslandSurfacePoint(island, distRatio, angle, extraY);
      return new THREE.Vector3(
        point.x - island.position.x,
        point.y,
        point.z - island.position.z,
      );
    };
    const SURFACE_ABOVE_WATER = 5.0;
    /** Client decor was seated on a SINGLE ground sample — on any slope the
     *  downhill edge floated in the air. Sample center + 4 compass offsets
     *  across the mesh footprint and lower to the minimum (capped so one
     *  cliff-edge sample can't swallow the piece); the slope normal lets big
     *  pieces tilt into the hillside instead of ledging out of it. */
    const seatDecor = (localX: number, localZ: number, footR: number, capSink = 0.4) => {
      const wx = localX + island.position.x;
      const wz = localZ + island.position.z;
      const c = getIslandSurfaceY(island, wx, wz);
      const xp = getIslandSurfaceY(island, wx + footR, wz);
      const xm = getIslandSurfaceY(island, wx - footR, wz);
      const zp = getIslandSurfaceY(island, wx, wz + footR);
      const zm = getIslandSurfaceY(island, wx, wz - footR);
      const drop = Math.min(capSink, Math.max(0, c - Math.min(c, xp, xm, zp, zm)));
      const normal = new THREE.Vector3((xm - xp) / (2 * footR), 2 * footR, (zm - zp) / (2 * footR)).normalize();
      return { groundY: c, drop, normal };
    };
    const carveCaveMouth = makeCaveMouthCarver(island);
    const isSolidDecorPoint = (point: THREE.Vector3, minY = SURFACE_ABOVE_WATER, margin = -0.35) => (
      point.y >= minY
      && isPointInsideIslandFootprint(
        island,
        point.x + island.position.x,
        point.z + island.position.z,
        margin,
      )
      // Never decorate the cave-mouth trench: the analytic surface these points
      // sample from gets carved open there, leaving tufts/outcrops hovering
      // mid-air inside the opening.
      && carveCaveMouth(point.x + island.position.x, point.z + island.position.z, point.y).carved < 0.3
    );
    // The island's real footprint radius — the terrain mesh sizes its rings off
    // it and the volcanic FX cull against it.
    const islandMaxR = getIslandMaxRadius(island);
    // Volcanic isles: the upper cone chars to ash, and glowing magma seeps
    // through cracks in the rock (per-vertex aMagma → emissive in the shader).
    const isVolcanic = (island.profile.biome ?? 'lush') === 'volcanic';

    // One per-island scratch record shared by every sub-builder below (see
    // island/context.ts). It holds exactly the values this method used to close
    // over, so the split is behaviour-neutral; `group` is the single sink and
    // the call order below is the scene-graph order.
    const ctx: IslandBuildCtx = {
      host: this.ctx,
      island,
      group,
      r,
      islandHeading,
      footprintX,
      footprintZ,
      islandSeed,
      rng,
      visualDetail,
      lowDetail,
      scaledCount,
      islandMaxR,
      isVolcanic,
      paletteSand,
      paletteGrass,
      paletteRock,
      paletteFoliage,
      whiteSand,
      beachColor,
      sandColor,
      grassColor,
      jungleColor,
      peakColor,
      cliffColor,
      mudColor,
      cliffMat,
      boulderMat,
      driftwoodMat,
      bambooMat,
      shrineMat,
      boulderGeo,
      bambooGeo,
      surfacePoint,
      SURFACE_ABOVE_WATER,
      seatDecor,
      isSolidDecorPoint,
      carveCaveMouth,
      buildPropInstance: (type, position, yaw, scale) => this.buildPropInstance(type, position, yaw, scale),
      applyFoliageSway: (material) => this.applyFoliageSway(material),
      blendStoryPad: (mesh, isle) => this.blendStoryPad(mesh, isle),
    };

    createLayer({
      topRadius: r * 1.02,
      bottomRadius: r * 1.26,
      height: r * 0.16,
      y: -r * 0.11,
      material: reefMat,
      radialSegments: 26,
      heightSegments: 5,
      scaleX: footprintX * 1.12,
      scaleZ: footprintZ * 1.12,
      shelf: 0.06,
      cliff: 0.03,
      cap: 0.005,
      jagged: 0.01,
      lean: 0.02,
    });

    // Heightfield mesh, vertex colours, the volcanic attributes, the per-pixel
    // detail shader and the underwater plinth (see island/TerrainMeshBuilder).
    const terrain = buildTerrainMesh(ctx);

    // Server prop registry: the palms/boulders/landmarks players collide with.
    this.buildServerProps(island, group, lowDetail);

    // ── Grass: one InstancedMesh of cross-plane tufts over the grassy interior.
    // Deterministic from the profile seed; culled with the micro tier past
    // ~260m; zero colliders (ankle-high ground cover).
    if (!lowDetail) {
      const grassCount = Math.min(9000, Math.round(r * r * 1.05));
      const bladeGeo = new THREE.PlaneGeometry(0.52, 0.64, 1, 1);
      bladeGeo.translate(0, 0.25, 0);
      const crossGeo = (() => {
        const a = bladeGeo.clone();
        const b = bladeGeo.clone();
        b.rotateY(Math.PI * 0.5);
        const merged = new THREE.BufferGeometry();
        const pa = a.getAttribute('position');
        const pb = b.getAttribute('position');
        const uva = a.getAttribute('uv');
        const uvb = b.getAttribute('uv');
        const positions = new Float32Array((pa.count + pb.count) * 3);
        positions.set(pa.array as Float32Array, 0);
        positions.set(pb.array as Float32Array, pa.count * 3);
        const uvs = new Float32Array((uva.count + uvb.count) * 2);
        uvs.set(uva.array as Float32Array, 0);
        uvs.set(uvb.array as Float32Array, uva.count * 2);
        const idxA = Array.from(a.getIndex()!.array);
        const idxB = Array.from(b.getIndex()!.array).map((i) => i + pa.count);
        merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        merged.setIndex([...idxA, ...idxB]);
        merged.computeVertexNormals();
        return merged;
      })();
      // White base: per-instance colors MULTIPLY material.color — a tinted
      // base squared every tuft toward black (the 'invisible grass' bug).
      const grassMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: makeGrassBladeTexture(),
        roughness: 0.94,
        side: THREE.DoubleSide,
        alphaTest: 0.42,
        transparent: false,
      });
      const grass = new THREE.InstancedMesh(crossGeo, grassMat, grassCount);
      const gM = new THREE.Matrix4();
      const gP = new THREE.Vector3();
      const gQ = new THREE.Quaternion();
      const gE = new THREE.Euler();
      const gS = new THREE.Vector3();
      const gColor = new THREE.Color();
      const seaBaseForGrass = 5.15 + r * 0.0085;
      let placed = 0;
      for (let i = 0; i < grassCount && placed < grassCount; i++) {
        const angle = rng(i * 7 + 3) * Math.PI * 2;
        const dRatio = 0.06 + rng(i * 11 + 5) * 0.86;
        const sample = surfacePoint(dRatio, angle, 0);
        // grassy band: above the beach, below the rocky heights, not too steep
        if (sample.y < seaBaseForGrass - 1.6) continue;
        if (sample.y > seaBaseForGrass + terrain.peakEst * 0.95) continue;
        const ahead = surfacePoint(dRatio + 0.015, angle, 0);
        if (Math.abs(ahead.y - sample.y) > 0.9) continue;
        // No tufts hovering in the cave-mouth trench (the mesh is carved open
        // below this analytic sample).
        if (carveCaveMouth(sample.x + island.position.x, sample.z + island.position.z, sample.y).carved > 0.25) continue;
        // Place a small CLUMP of blades per seed so grass reads as tufts and
        // masses (carpeting the interior), not isolated specks (audit P1).
        const clump = 2 + Math.floor(rng(i * 3 + 1) * 3); // 2-4 blades
        for (let c = 0; c < clump && placed < grassCount; c++) {
          const jx = (rng(i * 41 + c * 7) - 0.5) * 1.15;
          const jz = (rng(i * 43 + c * 11) - 0.5) * 1.15;
          gP.set(sample.x + jx, sample.y - 0.06, sample.z + jz);
          gE.set((rng(i * 13 + c) - 0.5) * 0.3, rng(i * 17 + c * 5) * Math.PI, (rng(i * 19 + c) - 0.5) * 0.3);
          gQ.setFromEuler(gE);
          // Height used to compound TWO independent draws (uniform scale ×
          // height factor), which multiplied out to 0.55x..2.39x — a 4.3x spread,
          // so blades in one tuft could differ more than fourfold. Draw the
          // uniform scale on its rails, then clamp the composed height to its own.
          const sc = floraScale(rng(i * 23 + c * 3), FLORA_SCALE.grass);
          gS.set(sc, clampFloraScale(sc * (0.92 + rng(i * 29 + c) * 0.36), FLORA_SCALE.grassHeight), sc);
          gM.compose(gP, gQ, gS);
          grass.setMatrixAt(placed, gM);
          gColor.copy(paletteGrass).lerp(paletteFoliage, rng(i * 31 + c) * 0.6).multiplyScalar(1.0 + rng(i * 37 + c) * 0.4);
          grass.setColorAt(placed, gColor);
          placed += 1;
        }
      }
      grass.count = placed;
      grass.instanceMatrix.needsUpdate = true;
      if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
      grass.castShadow = false;
      grass.receiveShadow = true;
      grass.name = 'island-grass';
      group.add(grass);

      // ── Ferns: taller arched fronds in the shaded inner jungle band ──
      const fernCount = Math.min(380, Math.round(r * r * 0.035));
      const fernGeo = crossGeo.clone();
      fernGeo.scale(1.15, 2.1, 1.15);
      {
        const fpos = fernGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < fpos.count; i++) {
          const fy = fpos.getY(i);
          // arch the tips outward for a frond silhouette
          fpos.setX(i, fpos.getX(i) * (1 + fy * 0.5));
          fpos.setZ(i, fpos.getZ(i) * (1 + fy * 0.5));
        }
        fpos.needsUpdate = true;
      }
      const ferns = new THREE.InstancedMesh(
        fernGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeFernFrondTexture(), roughness: 0.92, side: THREE.DoubleSide, alphaTest: 0.4 }),
        fernCount,
      );
      // Cluster ferns into leafy clumps (2-3 fronds per seed) instead of
      // isolated cards, so they read as bushes/groundcover not scattered
      // cardboard (patrol-3).
      let fernsPlaced = 0;
      for (let seed = 0; seed < fernCount && fernsPlaced < fernCount; seed++) {
        const angle = rng(seed * 41 + 9) * Math.PI * 2;
        const dRatio = 0.05 + rng(seed * 43 + 3) * 0.6;
        const sample = surfacePoint(dRatio, angle, 0);
        if (sample.y < seaBaseForGrass - 0.6 || sample.y > seaBaseForGrass + terrain.peakEst * 0.85) continue;
        if (carveCaveMouth(sample.x + island.position.x, sample.z + island.position.z, sample.y).carved > 0.25) continue;
        const clump = 2 + Math.floor(rng(seed * 71) * 2);
        for (let c = 0; c < clump && fernsPlaced < fernCount; c++) {
          const i = seed * 7 + c;
          gP.set(sample.x + (rng(i * 47) - 0.5) * 0.7, sample.y - 0.09, sample.z + (rng(i * 59) - 0.5) * 0.7);
          gE.set((rng(i * 47) - 0.5) * 0.24, rng(i * 53) * Math.PI * 2, (rng(i * 59) - 0.5) * 0.24);
          gQ.setFromEuler(gE);
          const sc = floraScale(rng(i * 61), FLORA_SCALE.fern);
          gS.set(sc, sc, sc);
          gM.compose(gP, gQ, gS);
          ferns.setMatrixAt(fernsPlaced, gM);
          gColor.copy(paletteFoliage).multiplyScalar(0.95 + rng(i * 67) * 0.55);
          ferns.setColorAt(fernsPlaced, gColor);
          fernsPlaced += 1;
        }
      }
      ferns.count = fernsPlaced;
      ferns.instanceMatrix.needsUpdate = true;
      if (ferns.instanceColor) ferns.instanceColor.needsUpdate = true;
      ferns.castShadow = false;
      ferns.receiveShadow = true;
      ferns.name = 'island-ferns';
      group.add(ferns);

      // ── Seashells + starfish flecks on the wet-sand band ──
      const shellCount = Math.min(240, Math.round(r * 2.2));
      const shellGeo = new THREE.SphereGeometry(0.09, 6, 4);
      shellGeo.scale(1.25, 0.4, 1);
      const shells = new THREE.InstancedMesh(
        shellGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72 }),
        shellCount,
      );
      const shellTints = [0xf6efe4, 0xe8cdbf, 0xdfa7a0, 0xc9d8d5, 0xf0dcc2];
      let shellsPlaced = 0;
      for (let i = 0; i < shellCount * 4 && shellsPlaced < shellCount; i++) {
        const angle = rng(i * 71 + 13) * Math.PI * 2;
        const dRatio = 0.86 + rng(i * 73 + 5) * 0.2;
        const sample = surfacePoint(dRatio, angle, 0);
        if (sample.y < 0.06 || sample.y > 1.5) continue; // wet-to-dry sand band only
        gP.set(sample.x, sample.y + 0.015, sample.z);
        gE.set(0, rng(i * 79) * Math.PI * 2, 0);
        gQ.setFromEuler(gE);
        const sc = floraScale(rng(i * 83), FLORA_SCALE.shell);
        gS.set(sc, sc, sc);
        gM.compose(gP, gQ, gS);
        shells.setMatrixAt(shellsPlaced, gM);
        gColor.setHex(shellTints[Math.floor(rng(i * 89) * shellTints.length) % shellTints.length]);
        shells.setColorAt(shellsPlaced, gColor);
        shellsPlaced += 1;
      }
      shells.count = shellsPlaced;
      shells.instanceMatrix.needsUpdate = true;
      if (shells.instanceColor) shells.instanceColor.needsUpdate = true;
      shells.castShadow = false;
      shells.receiveShadow = true;
      shells.name = 'island-shells';
      group.add(shells);
    }

    if (island.dock) {
      const dockW = Math.max(1, Math.min(120, Number(island.dock.width) || 8));
      const dockL = Math.max(1, Math.min(200, Number(island.dock.length) || 14));
      const dock = new THREE.Group();
      dock.position.set(
        island.dock.position.x - island.position.x,
        island.dock.position.y,
        island.dock.position.z - island.position.z,
      );
      dock.rotation.y = island.dock.rotation;

      const dockMat = new THREE.MeshStandardMaterial({ color: 0x7b5529, roughness: 0.95 });
      const beamMat = new THREE.MeshStandardMaterial({ color: 0x5e3d1d, roughness: 1 });
      const ropeMat = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
      const plankMats = [0x8d6230, 0x83592d, 0x976a35].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.96 }));

      // GLB dock modules: walkway runs along the module's local X (6×3 mid,
      // 4×3 end, deck at +1.1); the game dock runs along local Z. Purely a
      // visual swap — server walk/collision math is untouched.
      const dockUsesGlb = assets.has('dock_mid') && assets.has('dock_end');
      if (dockUsesGlb) {
        const MID_LEN = 6;
        const END_LEN = 4;
        const MODULE_W = 3;
        const DECK_H = 1.1;
        const midCount = Math.max(1, Math.round((dockL - END_LEN) / MID_LEN));
        const runLen = midCount * MID_LEN + END_LEN;
        const alongScale = dockL / runLen;
        const widthScale = dockW / MODULE_W;
        // Server walk surface sits at dock.position.y + 0.14; keep the visual deck flush with it.
        const moduleY = 0.18 - DECK_H;
        let cursor = -dockL * 0.5;
        for (let m = 0; m < midCount; m++) {
          const piece = assets.clone('dock_mid');
          if (!piece) break;
          piece.rotation.y = Math.PI * 0.5;
          piece.scale.set(alongScale, 1, widthScale);
          piece.position.set(0, moduleY, cursor + MID_LEN * alongScale * 0.5);
          dock.add(piece);
          cursor += MID_LEN * alongScale;
        }
        const endPiece = assets.clone('dock_end');
        if (endPiece) {
          endPiece.rotation.y = Math.PI * 0.5;
          endPiece.scale.set(alongScale, 1, widthScale);
          endPiece.position.set(0, moduleY, cursor + END_LEN * alongScale * 0.5);
          dock.add(endPiece);
        }
      } else {
        const deck = new THREE.Mesh(
          new THREE.BoxGeometry(dockW, 0.22, dockL),
          dockMat,
        );
        deck.position.y = 0.12;
        deck.castShadow = true;
        deck.receiveShadow = true;
        dock.add(deck);
      }

      const shorePlatform = new THREE.Mesh(
        new THREE.BoxGeometry(dockW * 1.2, 0.24, Math.min(4.6, dockL * 0.3)),
        dockMat,
      );
      shorePlatform.position.set(0, 0.14, -dockL * 0.34);
      shorePlatform.castShadow = true;
      shorePlatform.receiveShadow = true;
      dock.add(shorePlatform);

      // Seaward tip (+z in dock-local space) — matches DOCK_LADDER_LOCAL_Z_FRAC
      // on the server and getIslandDockSwimLadderPoint in shared/utils.
      const ladderZ = dockL * 0.44;
      const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95 });
      const rungMat = new THREE.MeshStandardMaterial({ color: 0x6a4828, roughness: 0.92 });
      const side = dockW * 0.22;
      for (const sx of [-side, side] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.1), railMat);
        rail.position.set(sx, 0.72, ladderZ - 0.12);
        rail.castShadow = true;
        dock.add(rail);
      }
      if (!lowDetail) {
        const rungCount = 8;
        for (let r = 0; r < rungCount; r++) {
          const rung = new THREE.Mesh(new THREE.BoxGeometry(side * 2.1, 0.07, 0.12), rungMat);
          rung.position.set(0, 0.18 + r * 0.14, ladderZ - r * 0.04);
          rung.castShadow = true;
          dock.add(rung);
        }

        if (!dockUsesGlb) {
          const plankCount = scaledCount(Math.round(dockW), 4);
          for (let i = 0; i < plankCount; i++) {
            const plank = new THREE.Mesh(
              new THREE.BoxGeometry(dockW / plankCount * 0.82, 0.04, dockL * 0.96),
                plankMats[i % plankMats.length],
            );
            plank.position.set(
              -dockW * 0.5 + (i + 0.5) * (dockW / plankCount),
              0.25,
              0,
            );
            plank.castShadow = true;
            plank.receiveShadow = true;
            dock.add(plank);
          }

          for (const side of [-1, 1] as const) {
            for (let i = 0; i < 4; i++) {
              const z = -dockL * 0.42 + i * (dockL * 0.28);
              const postHeight = 1.35 + rng(i * 191 + side) * 0.4;
              const post = new THREE.Mesh(
                new THREE.BoxGeometry(0.18, postHeight, 0.18),
                beamMat,
              );
              post.position.set(side * (island.dock.width * 0.45), postHeight * 0.45, z);
              post.castShadow = true;
              dock.add(post);

              if (i < 3) {
                const railLen = Math.max(0.15, dockL * 0.24);
                const rail = new THREE.Mesh(
                  new THREE.CylinderGeometry(0.035, 0.035, railLen, 6),
                  ropeMat,
                );
                rail.rotation.z = Math.PI * 0.5;
                rail.position.set(side * (dockW * 0.44), 0.88, z + dockL * 0.14);
                dock.add(rail);
              }
            }
          }
        }
      } else if (!dockUsesGlb) {
        for (const postSide of [-1, 1] as const) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.25, 0.18), beamMat);
          post.position.set(postSide * (dockW * 0.44), 0.65, dockL * 0.22);
          dock.add(post);
        }
      }

      const bollard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.13, 0.55, 8),
        beamMat,
      );
      bollard.position.set(island.dock.moorSide * dockW * 0.28, 0.26, dockL * 0.18);
      bollard.castShadow = true;
      dock.add(bollard);

      if (!lowDetail) {
        // Lanterns at the dock's shore end. Warm light is routed through the
        // night-budget system (registerLanternEmitter) instead of always-on lamps.
        if (assets.has('lantern_post')) {
          const deckY = dockUsesGlb ? 0.18 : 0.26;
          for (const lanternSide of [-1, 1] as const) {
            const post = this.buildPropInstance(
              'lantern_post',
              new THREE.Vector3(lanternSide * (dockW * 0.46 - 0.12), deckY, -dockL * 0.38),
              // lantern arm points +X in asset space — swing it inward over the walkway
              lanternSide === 1 ? Math.PI : 0,
            );
            if (post) dock.add(post);
            this.ctx.registerLanternEmitter(dock, lanternSide * (dockW * 0.46 - 0.12), deckY + 2.1, -dockL * 0.38, 'lantern');
          }
        } else {
          const lanternMat = new THREE.MeshStandardMaterial({
            color: 0x8b6c2a,
            emissive: 0xffcc44,
            emissiveIntensity: 0.5,
            roughness: 0.9,
          });
          for (const lanternSide of [-1, 1] as const) {
            const lanternPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.8, 0.16), beamMat);
            lanternPost.position.set(lanternSide * (dockW * 0.46), 0.9, -dockL * 0.38);
            lanternPost.castShadow = true;
            dock.add(lanternPost);

            const lanternBox = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), lanternMat);
            lanternBox.position.set(lanternSide * (dockW * 0.46), 1.95, -dockL * 0.38);
            dock.add(lanternBox);

            this.ctx.registerLanternEmitter(dock, lanternSide * (dockW * 0.46), 1.95, -dockL * 0.38, 'lantern');
          }
        }
      }

      group.add(dock);
    }

    if (island.tavern) {
      const t = island.tavern;
      const tavern = new THREE.Group();
      tavern.position.set(t.position.x - island.position.x, t.position.y, t.position.z - island.position.z);
      tavern.rotation.y = t.rotation;

      const beamMat2 = new THREE.MeshStandardMaterial({ color: 0x2f1d10, roughness: 1 });
      const counterMat = new THREE.MeshStandardMaterial({ color: 0x3f2616, roughness: 0.9 });
      const lanternMat2 = new THREE.MeshStandardMaterial({ color: 0x8b6c2a, emissive: 0xff9c44, emissiveIntensity: 0.65, roughness: 0.9 });

      const wallH = 3.0;
      const w = t.width;
      const d = t.depth;

      // Nice half-timbered tavern SHELL from Blender (seated gable roof, timber
      // framing, chimney, hanging sign) — replaces the old floating-roof boxes.
      // The GLB front (door) faces +Z, matching the tavern's dock-facing rotation.
      const shell = assets.clone('tavern');
      if (shell) {
        shell.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
        tavern.add(shell);
        // The GLB keeps the door leaf as its own node with the origin ON the
        // hinge axis — register it so [X] can swing it. The tavern DOES have a
        // server collider (walls plus a 1.7 m doorway gap); only the door LEAF
        // swing is cosmetic and client-only, so it needs no server round-trip.
        const doorNode = shell.getObjectByName('door');
        if (doorNode) {
          this.ctx.setTavernDoor(island.id, doorNode);
        }
      }

      if (!lowDetail) {
        // Bar counter inside the tavern, set back from the door
        const counter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 1.0, 0.7), counterMat);
        counter.position.set(0, 0.6, -d * 0.18);
        counter.castShadow = true;
        counter.receiveShadow = true;
        tavern.add(counter);
        // Counter top accent
        const counterTop = new THREE.Mesh(new THREE.BoxGeometry(w * 0.74, 0.06, 0.78), beamMat2);
        counterTop.position.set(0, 1.13, -d * 0.18);
        tavern.add(counterTop);

        // Stools at the bar
        for (let s = -1; s <= 1; s++) {
          const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.7, 8), counterMat);
          stool.position.set(s * 1.3, 0.35, -d * 0.18 + 0.85);
          stool.castShadow = true;
          tavern.add(stool);
        }

        // Tables
        for (const tableSide of [-1, 1] as const) {
          const tableGroup = new THREE.Group();
          tableGroup.position.set(tableSide * (w * 0.32), 0, d * 0.12);
          const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.2), counterMat);
          top.position.y = 0.78;
          top.castShadow = true;
          tableGroup.add(top);
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.78, 6), beamMat2);
          leg.position.y = 0.39;
          tableGroup.add(leg);
          tavern.add(tableGroup);
        }

        // Hanging lanterns under roof (warm light via the night-budget system).
        for (const lx of [-1.4, 1.4, 0] as const) {
          const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.34, 0.28), lanternMat2);
          lantern.position.set(lx, wallH - 0.3, 0);
          tavern.add(lantern);
          if (lx === 0) {
            this.ctx.registerLanternEmitter(tavern, 0, wallH - 0.4, 0, 'lantern');
          }
        }
      }

      // (Sign, chimney and roof now come from the Blender tavern GLB.)
      group.add(tavern);
    }

    // Walkable caves — terrain hollows out via getIslandSurfaceY, this block adds the
    // ceiling, side walls, back wall, entrance frame, and a torch so the cavern reads
    // as a real explorable cave you can step into.
    if (island.caves && island.caves.length > 0) {
      // Cave stone is the MOUNTAIN'S OWN rock (its palette, darkened for depth) so
      // the mouth reads as an opening carved into the rock face — not a foreign
      // pile of dark boulders bolted onto a smooth hillside.
      const caveRockCol = paletteRock.clone().multiplyScalar(0.44);
      // Slightly deeper tone for the continuous cave tube (both sides so you never
      // see a hole through a wall from any angle).
      // A faint warm self-glow on the cave stone so the deep interior reads as a
      // dim lantern-lit cavern instead of a pitch-black void where the torch
      // PointLights don't reach (they're range-culled for the light budget).
      // vertexColors carries the mouth-throat lightening (applyCaveTubeColors);
      // emissive raised so the interior reads dim-lit, not a blocked black void.
      const caveRockMat = new THREE.MeshStandardMaterial({
        color: caveRockCol.clone().multiplyScalar(0.82).getHex(), roughness: 1, flatShading: true, side: THREE.DoubleSide,
        emissive: new THREE.Color(0x30200f), emissiveIntensity: 0.75, vertexColors: true,
      });
      const torchMat = new THREE.MeshStandardMaterial({ color: 0x4a2f17, roughness: 1 });
      const flameMat = new THREE.MeshStandardMaterial({ color: 0xff8a20, emissive: 0xff5500, emissiveIntensity: 1.4, roughness: 0.4 });

      // Light budget for the (now much larger, multi-vein) cave network: every
      // segment still gets a glowing torch/crystal MESH (emissive, free), but only
      // the first several segments get a real dynamic PointLight so a deep warren
      // can't blow the renderer's light count. Torches go to the most-travelled
      // segments (mouth + junction + main veins come first in island.caves).
      let caveTorchBudget = lowDetail ? 6 : 12;
      let caveGlowBudget = lowDetail ? 2 : 6;

      for (const cave of island.caves) {
        const caveGroup = new THREE.Group();
        caveGroup.position.set(cave.position.x - island.position.x, cave.position.y, cave.position.z - island.position.z);
        caveGroup.rotation.y = cave.rotation;

        const cw = cave.width;
        const ch = cave.height;
        const cLen = (cave as { length?: number }).length ?? 10;
        const cR = (cave as { interiorRadius?: number }).interiorRadius ?? 3.0;
        // Floor sits at the SAME depth physics stands you on (cave.floorY), so
        // your feet meet the visible slab instead of floating ~0.6-1.3m above it.
        const floorLocalY = cave.floorY - cave.position.y;
        const ceilingLocalY = floorLocalY + ch;
        // Cave tunnel runs from local z=0 (entrance) to z=-cLen (back)

        // ── The mouth is an OPENING IN THE MOUNTAIN'S OWN ROCK — not a foreign
        //    boulder pile. A heavy overhanging BROW, two tall side JAMBS, shoulder
        //    blocks, and a few fallen slabs frame it, all in the cliff's own stone
        //    tone (charred on volcanoes) and slab-flattened (not round balls), so
        //    the DARK cavity behind them reads as a cave bored into the cliff. ──
        const isMouth = cave.hasMouth ?? true;
        // The exterior rock PORTAL (frame + the mouth's tube) is a landmark that
        // must read from across the island — it stays visible with the terrain.
        // Only the interior decor + lights hide behind the proximity gate below
        // (light budget). Non-mouth segments have no portal; all on caveGroup.
        let portalGroup: THREE.Group | null = null;
        if (isMouth) {
          portalGroup = new THREE.Group();
          portalGroup.position.copy(caveGroup.position);
          portalGroup.rotation.copy(caveGroup.rotation);
          group.add(portalGroup);
        }
        const exterior = portalGroup ?? caveGroup;
        if (isMouth) {
          const cliffCol = isVolcanic
            ? new THREE.Color(0x2b2621).lerp(paletteRock, 0.3)   // charred, matching the cone
            : paletteRock.clone().multiplyScalar(0.8);
          const cliffMat = new THREE.MeshStandardMaterial({ color: cliffCol.getHex(), roughness: 1, flatShading: true });
          // Overhanging brow across the crown (flattened slab jutting outward).
          const brow = new THREE.Mesh(boulderGeo, cliffMat);
          brow.scale.set(cR * 1.7, cR * 0.5, cR * 1.15);
          brow.position.set((rng(cw) - 0.5) * cR * 0.3, floorLocalY + ch * 1.02, 0.85);
          brow.rotation.set(-0.16 + rng(7) * 0.18, rng(9) * Math.PI, (rng(11) - 0.5) * 0.3);
          brow.castShadow = true;
          exterior.add(brow);
          // Side jambs + shoulder blocks — tall angular masses framing the opening.
          for (const side of [-1, 1] as const) {
            const jamb = new THREE.Mesh(boulderGeo, cliffMat);
            jamb.scale.set(cR * 0.72, cR * 1.32, cR * 1.02);
            jamb.position.set(side * (cR * 1.02), floorLocalY + ch * 0.44, 0.3);
            jamb.rotation.set((rng(side * 41) - 0.5) * 0.32, rng(side * 43) * Math.PI, side * 0.15);
            jamb.castShadow = true;
            exterior.add(jamb);
            const sh = new THREE.Mesh(boulderGeo, cliffMat);
            sh.scale.set(cR * 0.62, cR * 0.56, cR * 0.72);
            sh.position.set(side * (cR * 0.76), floorLocalY + ch * 0.9, 0.5);
            sh.rotation.set(rng(side * 51) * 0.4, rng(side * 53) * Math.PI, side * 0.28);
            sh.castShadow = true;
            exterior.add(sh);
          }
          // Fallen slabs at the threshold — rubble spilling from the mouth.
          for (let i = 0; i < (lowDetail ? 2 : 4); i++) {
            const fb = new THREE.Mesh(boulderGeo, cliffMat);
            const s = cR * (0.18 + rng(i * 71) * 0.22);
            fb.scale.set(s, s * 0.72, s);
            const side = i % 2 === 0 ? 1 : -1;
            fb.position.set(side * (cR * 0.5 + rng(i * 73) * cR * 0.5), floorLocalY + 0.2, 1.0 + rng(i * 77) * 1.7);
            fb.rotation.set(rng(i * 79) * Math.PI, rng(i * 83) * Math.PI, rng(i * 89) * Math.PI);
            fb.castShadow = true;
            exterior.add(fb);
          }
          // Warm glow spilling from the throat of the mouth — the entrance beckons
          // as you approach (rides the always-visible portal group, but the LIGHT
          // itself is distance-gated in updateEnvironmentLod like every other
          // decor light: an unbudgeted always-on PointLight per mouth multiplies
          // every island's forward-pass lighting cost across the whole map).
          const mouthGlow = new THREE.PointLight(0xffa24d, 4.4, cR * 5.5, 1.0);
          mouthGlow.position.set(0, floorLocalY + ch * 0.42, -1.4);
          mouthGlow.visible = false;
          exterior.add(mouthGlow);
          (group.userData.caveMouthGlows ??= []).push({ light: mouthGlow, x: cave.position.x, z: cave.position.z });
          // Ember glow disc just inside the throat — an always-on additive
          // wash of warm light (no light budget), so the opening reads OPEN
          // from approach distance even before the gated PointLight kicks in.
          const ember = new THREE.Mesh(
            new THREE.CircleGeometry(cR * 0.52, 20),
            new THREE.MeshBasicMaterial({
              color: 0xff9a40, transparent: true, opacity: 0.2,
              blending: THREE.AdditiveBlending, depthWrite: false,
            }),
          );
          ember.position.set(0, floorLocalY + ch * 0.45, -2.4);
          exterior.add(ember);
        }

        // ── The cave itself: one CONTINUOUS enclosed rock tube (floor + walls +
        //    arched ceiling), organically displaced — replaces the old flat
        //    floor/wall/ceiling slabs that left black gaps. Dead-ends get a
        //    fan-capped back; mouths/junctions stay open so segments connect. ──
        const floorEndLocalY = ((cave as { floorYEnd?: number }).floorYEnd ?? cave.floorY) - cave.position.y;
        // Overshoot the tube 1.2m past its nominal end so its open rim lands
        // INSIDE the connecting segment's walls: butt-joined open rims meeting
        // at an angle left wedge gaps at every junction (bright slits of sky
        // where a sightline threaded between the two rims). The floor ramp
        // continues at the same gradient — the overshoot buries harmlessly
        // under the neighbour's floor.
        const tubeLen = cLen + 1.2;
        const tubeFloorEnd = cLen > 0 ? floorEndLocalY + (floorEndLocalY - floorLocalY) * (1.2 / cLen) : floorEndLocalY;
        const tubeGeo = makeCaveTubeGeometry(cR, tubeLen, floorLocalY, ceilingLocalY, cw * 7.3 + cLen * 2.1 + cR, cave.hasBackWall ?? true, tubeFloorEnd);
        // Junction fix: drop wall triangles standing inside a NEIGHBOUR's open
        // interior (physics walks the union — those walls were fake).
        cullCaveTubeAgainstNeighbors(tubeGeo, cave, island);
        applyCaveTubeColors(tubeGeo, isMouth);
        const tube = new THREE.Mesh(tubeGeo, caveRockMat);
        tube.receiveShadow = true;
        // Mouth tube rides with the always-visible portal so the entrance has real
        // dark depth (and no see-through) from a distance; deeper interior segments
        // stay gated (only seen once you're inside).
        exterior.add(tube);

        // ── Throat COLLAR (mouths only): a short, wider rock tube wrapping the
        //    first ~7m of the passage. The terrain's carved→natural transition
        //    face lands inside it (unavoidable at terrain-mesh resolution — it
        //    used to slice visibly across the tunnel), and it seals the sliver
        //    gaps between the arch and the trench walls. DoubleSide: its outer
        //    face is the portal's rocky throat seen from the approach. ──
        if (isMouth) {
          const collarLen = Math.min(7.0, cLen * 0.95);
          const collarFloorEnd = floorLocalY + (floorEndLocalY - floorLocalY) * (collarLen / Math.max(1, cLen));
          // Lighter than the deep-tube stone: the collar IS the visible throat
          // from outside — at ×0.36 it read as a boulder blocking the mouth.
          const collarMat = new THREE.MeshStandardMaterial({
            color: paletteRock.clone().multiplyScalar(0.62).getHex(), roughness: 1, flatShading: true, side: THREE.DoubleSide,
            emissive: new THREE.Color(0x30200f), emissiveIntensity: 0.55,
          });
          const collar = new THREE.Mesh(
            makeCaveTubeGeometry(cR * 1.26, collarLen, floorLocalY - 0.02, floorLocalY + ch * 1.08, cw * 3.1 + 17, false, collarFloorEnd - 0.02),
            collarMat,
          );
          collar.receiveShadow = true;
          exterior.add(collar);
        }

        // ── Stalactite + stalagmite accents ──
        const stoneAccentMat = new THREE.MeshStandardMaterial({ color: caveRockCol.clone().multiplyScalar(1.35).getHex(), roughness: 1, flatShading: true });
        const accentCount = lowDetail ? 3 : 6;
        for (let s = 0; s < accentCount; s++) {
          const lz = -1 - rng(s * 401) * (cLen - 2);
          const lx = (rng(s * 403) - 0.5) * cR * 1.4;
          const stalH = 0.4 + rng(s * 407) * 0.7;
          const fromCeiling = rng(s * 409) > 0.5;
          const stal = new THREE.Mesh(
            new THREE.ConeGeometry(0.16 + rng(s * 411) * 0.12, stalH, 5),
            stoneAccentMat,
          );
          if (fromCeiling) {
            stal.position.set(lx, ceilingLocalY - stalH * 0.5, lz);
            stal.rotation.x = Math.PI;
          } else {
            stal.position.set(lx, floorLocalY + stalH * 0.5, lz);
          }
          caveGroup.add(stal);
        }

        // ── Torch sconce on the side wall + warm point light so the inside isn't pitch-black ──
        const torchSide = rng(cw * 7) > 0.5 ? 1 : -1;
        const torchZ = -cLen * 0.55;
        const torchMount = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), torchMat);
        torchMount.position.set(torchSide * (cR - 0.1), floorLocalY + ch * 0.65, torchZ);
        caveGroup.add(torchMount);
        const torchStaff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.55, 5), torchMat);
        torchStaff.rotation.z = -torchSide * 0.45;
        torchStaff.position.set(torchSide * (cR - 0.18), floorLocalY + ch * 0.78, torchZ);
        caveGroup.add(torchStaff);
        const flame = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), flameMat);
        flame.position.set(torchSide * (cR - 0.34), floorLocalY + ch * 0.95, torchZ);
        caveGroup.add(flame);
        // Underground is dark regardless of day/night, so caves get their OWN
        // always-on warm torch light (parented to the group → only lit when the
        // cave is in view range, so no global light-budget blowout).
        if (caveTorchBudget > 0) {
          caveTorchBudget--;
          const torchLight = new THREE.PointLight(0xffb060, 4.4, cLen + cR * 3.0, 1.4);
          torchLight.position.copy(flame.position);
          caveGroup.add(torchLight);
        }
        // Sparse glowing crystals deeper in — cool blue emissive clusters with a
        // faint light each, so the tunnel reads as lit but moody, not a flat box.
        if (!lowDetail) {
          const crystalMat = new THREE.MeshStandardMaterial({ color: 0x6fd3ff, emissive: 0x2f8fe0, emissiveIntensity: 2.2, roughness: 0.3 });
          const clusters = 2 + Math.floor(rng(cw * 5) * 2);
          for (let c = 0; c < clusters; c++) {
            const cz = -cLen * (0.4 + c * 0.28) - rng(c * 91) * 1.2;
            const cx = (rng(c * 93) - 0.5) * cR * 1.5;
            const onCeil = rng(c * 95) > 0.6;
            const cy = onCeil ? ceilingLocalY - 0.3 : floorLocalY + 0.1;
            for (let s = 0; s < 3; s++) {
              const shard = new THREE.Mesh(new THREE.ConeGeometry(0.06 + rng(c * 97 + s) * 0.05, 0.3 + rng(c * 99 + s) * 0.4, 5), crystalMat);
              shard.position.set(cx + (rng(s * 13) - 0.5) * 0.4, cy + (onCeil ? -0.15 : 0.15), cz + (rng(s * 17) - 0.5) * 0.4);
              shard.rotation.set(rng(s * 19) * 0.6 - 0.3 + (onCeil ? Math.PI : 0), rng(s * 21) * Math.PI, rng(s * 23) * 0.6 - 0.3);
              caveGroup.add(shard);
            }
            if (caveGlowBudget > 0) {
              caveGlowBudget--;
              const glow = new THREE.PointLight(0x5fbfff, 1.1, 6.5, 1.8);
              glow.position.set(cx, cy, cz);
              caveGroup.add(glow);
            }
          }
        }

        // ── Treasure chest tucked at the back of the cave (visual only — gameplay
        //     chests still spawn from server). Only in the dead-end treasure room. ──
        if ((cave.hasBackWall ?? true) && rng(cw * 11) > 0.35 && !lowDetail) {
          const goldChestMat = new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.95 });
          const goldLidMat = new THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.5, metalness: 0.6 });
          const treasure = new THREE.Group();
          treasure.position.set(0, floorLocalY + 0.35, -cLen + 1.0);
          treasure.rotation.y = (rng(cw * 13) - 0.5) * 0.6;
          const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.55, 0.7), goldChestMat);
          body.position.y = 0;
          treasure.add(body);
          const lid = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.18, 0.74), goldLidMat);
          lid.position.y = 0.32;
          treasure.add(lid);
          caveGroup.add(treasure);
        }

        // Cave interiors are boxy meshes carved into a steep hillside — their
        // dark ceiling/wall slabs poke out through the terrain shell and read
        // as black slabs floating on the mountain from a distance. Gate their
        // visibility to camera proximity (world entrance pos cached on the
        // group): you only see the hollow when you're near enough to be about
        // to enter it. Also a perf win (dozens of hidden slabs at range).
        caveGroup.userData.caveEntranceWorld = {
          x: cave.position.x,
          y: cave.position.y,
          z: cave.position.z,
        };
        (group.userData.caveGroups ??= []).push(caveGroup);
        group.add(caveGroup);
      }
    }

    // (Client-only boulder/palm scatter removed: palms and boulders now come
    // from the server prop registry via buildServerProps — visuals match the
    // colliders players actually hit. Micro-decor below has no colliders.)

    const outcropCount = scaledCount(Math.round(r / 18), 2);
    for (let i = 0; i < outcropCount; i++) {
      const angle = islandHeading + i * ((Math.PI * 2) / outcropCount) + rng(i * 43) * 0.55;
      const distRatio = 0.62 + rng(i * 47) * 0.14;
      const ocH = Math.max(0.12, 0.85 + rng(i * 61) * 0.9);
      const outcropSample = surfacePoint(distRatio, angle, ocH * 0.22);
      if (!isSolidDecorPoint(outcropSample)) continue; // archipelago saddle — skip
      const ocScale = 0.9 + rng(i * 79) * 0.6;
      const outcrop = new THREE.Mesh(
        new THREE.CylinderGeometry(
          Math.max(0.06, 0.18 + rng(i * 53) * 0.2),
          Math.max(0.06, 0.34 + rng(i * 59) * 0.22),
          ocH,
          6,
        ),
        cliffMat,
      );
      outcrop.position.copy(outcropSample);
      outcrop.position.y -= seatDecor(outcropSample.x, outcropSample.z, 0.5 * ocScale).drop;
      outcrop.rotation.set(rng(i * 67) * 0.2, rng(i * 71) * Math.PI * 2, (rng(i * 73) - 0.5) * 0.28);
      outcrop.scale.setScalar(ocScale);
      outcrop.castShadow = true;
      outcrop.receiveShadow = true;
      group.add(outcrop);
    }

    const driftwoodCount = lowDetail ? 0 : 3 + Math.floor(rng(islandSeed) * 3);
    for (let i = 0; i < driftwoodCount; i++) {
      const angle = rng(i * 223 + 7) * Math.PI * 2;
      const distRatio = 0.76 + rng(i * 229) * 0.16;
      const logPos = surfacePoint(distRatio, angle, 0.04);
      if (!isSolidDecorPoint(logPos, SURFACE_ABOVE_WATER, -0.2)) continue;
      const logLen = 1.4 + rng(i * 233) * 2.2;
      const log = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08 + rng(i * 239) * 0.05, 0.11, logLen, 6),
        driftwoodMat,
      );
      log.position.copy(logPos);
      log.rotation.set(
        (rng(i * 241) - 0.5) * 0.28,
        rng(i * 243) * Math.PI * 2,
        (rng(i * 247) - 0.5) * 0.22,
      );
      log.castShadow = false;
      log.receiveShadow = true;
      group.add(log);
    }

    // Bamboo clusters on larger islands
    if (!lowDetail && r > 52) {
      const bambooClusters = 1 + Math.floor(rng(islandSeed * 3 + 1) * 2);
      for (let g = 0; g < bambooClusters; g++) {
        const clusterAngle = rng(g * 251) * Math.PI * 2;
        const clusterDist = 0.12 + rng(g * 257) * 0.22;
        const clusterCenter = surfacePoint(clusterDist, clusterAngle);
        if (!isSolidDecorPoint(clusterCenter)) continue;
        const stalkCount = 3 + Math.floor(rng(g * 263) * 3);
        for (let b = 0; b < stalkCount; b++) {
          const bh = 3.2 + rng(g * 269 + b) * 2.8;
          const bamboo = new THREE.Mesh(bambooGeo, bambooMat);
          // AUDIT P2: every stalk in a cluster shared the CENTRE's ground height,
          // so on a slope the outer stalks hung 0.3-0.6m in the air with their
          // bases cut off. Seat each stalk on its own sample (sunk 0.15m).
          const bx = clusterCenter.x + (rng(b * 271 + g) - 0.5) * 1.4;
          const bz = clusterCenter.z + (rng(b * 277 + g) - 0.5) * 1.4;
          const by = getIslandSurfaceY(island, bx + island.position.x, bz + island.position.z) - 0.15;
          bamboo.position.set(bx, bh * 0.5 + by, bz);
          bamboo.rotation.set(
            (rng(b * 279 + g) - 0.5) * 0.1,
            rng(b * 281 + g) * Math.PI * 2,
            (rng(b * 283 + g) - 0.5) * 0.1,
          );
          bamboo.scale.y = bh;
          bamboo.castShadow = false;
          group.add(bamboo);
        }
      }
    }

    if (!lowDetail && r > 38) {
      const wreckAngle = islandHeading + Math.PI * (0.55 + rng(islandSeed * 7) * 0.5);
      const wreckPos = surfacePoint(0.82 + rng(islandSeed * 11) * 0.08, wreckAngle, 0.0);
      const wreckSolid = isSolidDecorPoint(wreckPos, SURFACE_ABOVE_WATER, -0.15);
      const wreckGlb = wreckSolid
        ? this.buildPropInstance(
          'shipwreck',
          wreckPos,
          -wreckAngle + Math.PI * 0.5,
          THREE.MathUtils.clamp(r / 70, 0.55, 1.0),
        )
        : null;
      if (wreckGlb) {
        // Beached hull skeleton from the GLB library (interim placement — a
        // later pass moves landmarks to the server prop registry).
        wreckGlb.rotation.z = (rng(islandSeed * 19) - 0.5) * 0.2;
        group.add(wreckGlb);
      }
    }

    // ── Beach detail: shells, starfish, seaweed clumps, tide pools, washed-up jellyfish ──
    if (!lowDetail) {
      const shellMat = new THREE.MeshStandardMaterial({ color: 0xf6e3b8, roughness: 0.6 });
      const shellMatPink = new THREE.MeshStandardMaterial({ color: 0xf2b5b0, roughness: 0.55 });
      const seaweedMat = new THREE.MeshStandardMaterial({ color: 0x2d5b2c, roughness: 0.95, side: THREE.DoubleSide });
      const starfishMat = new THREE.MeshStandardMaterial({ color: 0xe07a36, roughness: 0.9 });
      const tidePoolMat = new THREE.MeshBasicMaterial({ color: 0x3a86a8, transparent: true, opacity: 0.7 });

      const beachItems = scaledCount(Math.round(r / 9), 4);
      for (let i = 0; i < beachItems; i++) {
        const angle = rng(i * 601 + 11) * Math.PI * 2;
        const distRatio = 0.78 + rng(i * 607) * 0.18;
        const pos = surfacePoint(distRatio, angle, 0.04);
        if (pos.y > 5.5 || !isSolidDecorPoint(pos, 0.2, -0.18)) continue; // beach only
        const pick = rng(i * 613) * 4;
        if (pick < 1) {
          // Conch shell
          const shell = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 8), rng(i * 617) > 0.5 ? shellMat : shellMatPink);
          shell.position.copy(pos);
          shell.rotation.z = Math.PI * 0.5 + (rng(i * 619) - 0.5) * 0.4;
          shell.rotation.y = rng(i * 623) * Math.PI * 2;
          shell.scale.setScalar(0.7 + rng(i * 631) * 0.6);
          shell.castShadow = false;
          group.add(shell);
        } else if (pick < 2) {
          // Bivalve
          const half = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), shellMat);
          half.position.copy(pos);
          half.rotation.y = rng(i * 637) * Math.PI * 2;
          half.scale.setScalar(0.6 + rng(i * 641) * 0.8);
          group.add(half);
        } else if (pick < 3) {
          // Starfish (5-arm)
          const star = new THREE.Group();
          star.position.copy(pos);
          star.rotation.y = rng(i * 643) * Math.PI * 2;
          for (let arm = 0; arm < 5; arm++) {
            const a = (arm / 5) * Math.PI * 2;
            const limb = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.28, 5), starfishMat);
            limb.rotation.z = -Math.PI * 0.5;
            limb.rotation.y = a;
            limb.position.set(Math.cos(a) * 0.14, 0.04, Math.sin(a) * 0.14);
            star.add(limb);
          }
          star.scale.setScalar(0.7 + rng(i * 647) * 0.5);
          group.add(star);
        } else {
          // Seaweed / kelp clump
          const clump = new THREE.Group();
          clump.position.copy(pos);
          for (let s = 0; s < 5; s++) {
            const blade = new THREE.Mesh(new THREE.PlaneGeometry(0.12 + rng(s * 651 + i) * 0.08, 0.6 + rng(s * 653 + i) * 0.6), seaweedMat);
            blade.position.set((rng(s * 657 + i) - 0.5) * 0.2, 0.3, (rng(s * 659 + i) - 0.5) * 0.2);
            blade.rotation.set((rng(s * 661 + i) - 0.5) * 0.4, rng(s * 663 + i) * Math.PI * 2, (rng(s * 667 + i) - 0.5) * 0.6);
            clump.add(blade);
          }
          group.add(clump);
        }
      }

      // Tide pools — small flat blue disks where rocks shelter water on the rocky shore
      if (!lowDetail) {
        const tidePoolCount = scaledCount(Math.round(r / 30), 1);
        for (let i = 0; i < tidePoolCount; i++) {
          const angle = rng(i * 671 + 7) * Math.PI * 2;
          const distRatio = 0.84 + rng(i * 677) * 0.1;
          const pos = surfacePoint(distRatio, angle, 0.02);
          if (pos.y > 5.7 || !isSolidDecorPoint(pos, 0.2, -0.18)) continue;
          const pool = new THREE.Mesh(
            new THREE.CircleGeometry(0.7 + rng(i * 681) * 0.6, 14),
            tidePoolMat,
          );
          pool.rotation.x = -Math.PI * 0.5;
          pool.position.copy(pos);
          pool.position.y += 0.02;
          group.add(pool);
          // Encircling rocks — each seated on the ground at ITS OWN offset
          // (they ringed the pool at the pool-center height and floated on
          // any shore slope).
          for (let r2 = 0; r2 < 5; r2++) {
            const ra = (r2 / 5) * Math.PI * 2;
            const rock = new THREE.Mesh(boulderGeo, boulderMat);
            const rockScale = 0.16 + rng(r2 * 683 + i) * 0.18;
            rock.scale.setScalar(rockScale);
            const rx = pos.x + Math.cos(ra) * (0.85 + rng(r2 * 687 + i) * 0.3);
            const rz = pos.z + Math.sin(ra) * (0.85 + rng(r2 * 689 + i) * 0.3);
            const seat = seatDecor(rx, rz, rockScale * 0.9);
            rock.position.set(rx, seat.groundY - seat.drop + rockScale * 0.45, rz);
            rock.rotation.set(rng(r2 * 691) * Math.PI, rng(r2 * 693) * Math.PI, rng(r2 * 697) * Math.PI);
            group.add(rock);
          }
        }
      }
    }

    // (Snow on tall mountains is now painted into the terrain vertex colours
    // above — the snow line — instead of a floating cone + flat patches.)

    // ── Volcanic isle FX: caldera lava, ashfall, embers, smoke, geyser plumes ──
    if (isVolcanic) {
      const pulse = this.ctx.magmaPulseUniform;
      const particleTex = this.ctx.getSoftParticleTexture();
      const islandCenter = new THREE.Vector3(island.position.x, 0, island.position.z);
      const cullRadius = islandMaxR + 440;

      // Caldera / peak position — anchors the smoke plume + ember source. The
      // molten glow of the crater is painted into the summit TERRAIN (aMagma
      // summitGlow above), so there's no flat floating lava disc.
      const peakAngle = island.profile.primaryHillAngle;
      const peakOffset = island.profile.primaryHillOffset;
      const cpx = Math.cos(peakAngle) * peakOffset * footprintX;
      const cpz = Math.sin(peakAngle) * peakOffset * footprintZ;
      const peakY = getIslandSurfaceY(island, cpx + island.position.x, cpz + island.position.z);
      const lavaR = Math.max(2.6, r * 0.055);

      // Ashfall — grey flakes settling over the whole island (drift + wrap).
      const baseAshY = Math.max(6, peakY * 0.4);
      const ashTopY = peakY + 46;
      const ashCount = lowDetail ? 70 : Math.round(200 * visualDetail);
      {
        const pos = new Float32Array(ashCount * 3);
        const spd = new Float32Array(ashCount);
        for (let i = 0; i < ashCount; i++) {
          const a = rng(i * 91) * Math.PI * 2;
          const rad = Math.sqrt(rng(i * 47 + 3)) * islandMaxR * 0.98;
          pos[i * 3] = Math.cos(a) * rad;
          pos[i * 3 + 1] = baseAshY + rng(i * 13 + 7) * (ashTopY - baseAshY);
          pos[i * 3 + 2] = Math.sin(a) * rad;
          spd[i] = 2.2 + rng(i * 29) * 2.4;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ size: 0.5, map: particleTex, color: 0x8f8880, transparent: true, opacity: 0.5, depthWrite: false });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        group.add(points);
        this.ctx.pushVolcanicFx((dt, _wt, cam) => {
          const vis = cam.distanceTo(islandCenter) <= cullRadius;
          points.visible = vis;
          if (!vis) return;
          for (let i = 0; i < ashCount; i++) {
            let y = pos[i * 3 + 1] - spd[i] * dt;
            let x = pos[i * 3] + 0.7 * dt;
            let z = pos[i * 3 + 2] + 0.35 * dt;
            if (y < baseAshY) {
              y = ashTopY;
              const a = Math.random() * Math.PI * 2;
              const rad = Math.sqrt(Math.random()) * islandMaxR * 0.98;
              x = Math.cos(a) * rad;
              z = Math.sin(a) * rad;
            }
            pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
          }
          geo.attributes.position.needsUpdate = true;
        });
      }

      // Embers rising off the caldera (additive, flicker with the pulse).
      if (!lowDetail) {
        const emberCount = 40;
        const emberTop = peakY + 18;
        const pos = new Float32Array(emberCount * 3);
        const spd = new Float32Array(emberCount);
        for (let i = 0; i < emberCount; i++) {
          const a = rng(i * 71 + 5) * Math.PI * 2;
          const rad = Math.sqrt(rng(i * 53 + 1)) * lavaR * 2.2;
          pos[i * 3] = cpx + Math.cos(a) * rad;
          pos[i * 3 + 1] = peakY + rng(i * 19) * (emberTop - peakY);
          pos[i * 3 + 2] = cpz + Math.sin(a) * rad;
          spd[i] = 3.0 + rng(i * 37) * 3.5;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ size: 0.42, map: particleTex, color: 0xff8b2e, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        group.add(points);
        this.ctx.pushVolcanicFx((dt, _wt, cam) => {
          const vis = cam.distanceTo(islandCenter) <= cullRadius;
          points.visible = vis;
          if (!vis) return;
          mat.opacity = 0.55 + 0.4 * pulse.value;
          for (let i = 0; i < emberCount; i++) {
            let y = pos[i * 3 + 1] + spd[i] * dt;
            let x = pos[i * 3] + Math.sin(_wt * 1.7 + i) * 0.6 * dt;
            if (y > emberTop) {
              y = peakY;
              const a = Math.random() * Math.PI * 2;
              const rad = Math.sqrt(Math.random()) * lavaR * 2.2;
              x = cpx + Math.cos(a) * rad;
              pos[i * 3 + 2] = cpz + Math.sin(a) * rad;
            }
            pos[i * 3] = x; pos[i * 3 + 1] = y;
          }
          geo.attributes.position.needsUpdate = true;
        });
      }

      // Smoke column billowing off the caldera (widens as it rises).
      {
        const smokeCount = lowDetail ? 22 : 44;
        const smokeTop = peakY + 60;
        const pos = new Float32Array(smokeCount * 3);
        const ang = new Float32Array(smokeCount);
        const spd = new Float32Array(smokeCount);
        for (let i = 0; i < smokeCount; i++) {
          ang[i] = rng(i * 61 + 9) * Math.PI * 2;
          const y = peakY + rng(i * 23 + 2) * (smokeTop - peakY);
          const hf = (y - peakY) / (smokeTop - peakY);
          const rad = 1.6 + hf * 9;
          pos[i * 3] = cpx + Math.cos(ang[i]) * rad;
          pos[i * 3 + 1] = y;
          pos[i * 3 + 2] = cpz + Math.sin(ang[i]) * rad;
          spd[i] = 2.4 + rng(i * 41) * 2.2;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ size: 6.5, map: particleTex, color: 0x2b2724, transparent: true, opacity: 0.34, depthWrite: false });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        group.add(points);
        this.ctx.pushVolcanicFx((dt, _wt, cam) => {
          const vis = cam.distanceTo(islandCenter) <= cullRadius;
          points.visible = vis;
          if (!vis) return;
          for (let i = 0; i < smokeCount; i++) {
            let y = pos[i * 3 + 1] + spd[i] * dt;
            if (y > smokeTop) y = peakY + (y - smokeTop);
            const hf = (y - peakY) / (smokeTop - peakY);
            const rad = 1.6 + hf * 9;
            pos[i * 3] = cpx + Math.cos(ang[i] + _wt * 0.12) * rad;
            pos[i * 3 + 1] = y;
            pos[i * 3 + 2] = cpz + Math.sin(ang[i] + _wt * 0.12) * rad;
          }
          geo.attributes.position.needsUpdate = true;
        });
      }

      // ── Geyser vents + erupting plumes (synced to the server launch) ──
      for (const geyser of island.geysers ?? []) {
        const gx = geyser.x - island.position.x;
        const gz = geyser.z - island.position.z;
        const gy = geyser.y;
        // ── Vent: a real cracked-stone rim around a recessed dark throat ──
        // (was a flat orange RingGeometry decal + emissive disc lying on the
        // grass — the open backlog defect: "geyser vents are painted circles").
        const ventR = Math.max(0.9, geyser.radius);
        const ventRock = new THREE.MeshStandardMaterial({
          color: paletteRock.clone().multiplyScalar(0.42).getHex(), roughness: 1, flatShading: true,
        });
        const rimChunks = lowDetail ? 7 : 11;
        const rimMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), ventRock, rimChunks);
        rimMesh.name = 'geyser-rim';
        const rimM = new THREE.Matrix4();
        const rimP = new THREE.Vector3();
        const rimQ = new THREE.Quaternion();
        const rimE = new THREE.Euler();
        const rimS = new THREE.Vector3();
        for (let c = 0; c < rimChunks; c++) {
          const a = (c / rimChunks) * Math.PI * 2 + rng(c * 61 + 5) * 0.35;
          const rr = ventR * (0.92 + rng(c * 67 + 11) * 0.30);
          const cx = gx + Math.cos(a) * rr;
          const cz = gz + Math.sin(a) * rr;
          const cy = getIslandSurfaceY(island, cx + island.position.x, cz + island.position.z);
          const s = ventR * (0.24 + rng(c * 71 + 3) * 0.24);
          rimS.set(s * (0.8 + rng(c * 73) * 0.7), s * (0.7 + rng(c * 79) * 0.9), s * (0.8 + rng(c * 83) * 0.6));
          // Rim stones lean OUTWARD, as if shouldered up by the vent.
          rimP.set(cx, cy + s * 0.22, cz);
          rimE.set((rng(c * 89) - 0.5) * 0.5, a, 0.22 + rng(c * 97) * 0.3);
          rimQ.setFromEuler(rimE);
          rimMesh.setMatrixAt(c, rimM.compose(rimP, rimQ, rimS));
        }
        rimMesh.instanceMatrix.needsUpdate = true;
        rimMesh.castShadow = !lowDetail;
        rimMesh.receiveShadow = true;
        group.add(rimMesh);
        // Recessed throat: a dark cone sunk into the ground, with a small
        // molten core disc at the bottom — depth instead of a painted circle.
        const throatDepth = Math.max(0.7, ventR * 0.9);
        const throat = new THREE.Mesh(
          new THREE.ConeGeometry(ventR * 0.72, throatDepth, 14, 1, true),
          new THREE.MeshStandardMaterial({
            color: 0x140f0c, roughness: 1, side: THREE.DoubleSide, emissive: 0x3a1204, emissiveIntensity: 0.35,
          }),
        );
        throat.position.set(gx, gy - throatDepth * 0.42, gz);
        group.add(throat);
        const ventCore = new THREE.Mesh(
          new THREE.CircleGeometry(ventR * 0.34, 12),
          new THREE.MeshStandardMaterial({
            color: 0x1a0d06, roughness: 0.85, emissive: 0xff5a18, emissiveIntensity: 1.4,
          }),
        );
        ventCore.rotation.x = -Math.PI * 0.5;
        ventCore.position.set(gx, gy - throatDepth * 0.86, gz);
        group.add(ventCore);
        // Idle steam: a permanent lazy wisp so a dormant vent still reads as
        // ALIVE from a distance (the old vent was invisible when not erupting).
        const idleCount = lowDetail ? 5 : 9;
        const idlePos = new Float32Array(idleCount * 3);
        const idlePhase = new Float32Array(idleCount);
        const idleAng = new Float32Array(idleCount);
        for (let i = 0; i < idleCount; i++) {
          idlePhase[i] = rng(i * 131 + 9);
          idleAng[i] = rng(i * 137 + 13) * Math.PI * 2;
          idlePos[i * 3] = gx; idlePos[i * 3 + 1] = gy; idlePos[i * 3 + 2] = gz;
        }
        const idleGeo = new THREE.BufferGeometry();
        idleGeo.setAttribute('position', new THREE.BufferAttribute(idlePos, 3));
        const idleMat = new THREE.PointsMaterial({
          size: ventR * 1.05, map: particleTex, color: 0xbfcdd2, transparent: true, opacity: 0.17, depthWrite: false,
        });
        const idleSteam = new THREE.Points(idleGeo, idleMat);
        idleSteam.frustumCulled = false;
        group.add(idleSteam);

        // Plume: a steam/water column that rises only while erupting.
        const plumeCount = lowDetail ? 40 : 130;
        const plumeH = Math.max(9, geyser.power * 0.7);
        const pos = new Float32Array(plumeCount * 3);
        const phase = new Float32Array(plumeCount);
        const ang = new Float32Array(plumeCount);
        for (let i = 0; i < plumeCount; i++) {
          phase[i] = rng(i * 17 + 3);
          ang[i] = rng(i * 29 + 7) * Math.PI * 2;
          pos[i * 3] = gx;
          pos[i * 3 + 1] = gy;
          pos[i * 3 + 2] = gz;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ size: 1.35, map: particleTex, color: 0xeaf6fb, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const plume = new THREE.Points(geo, mat);
        plume.frustumCulled = false;
        group.add(plume);
        // Ground splash: a low mist ring that punches out at the base of a jet.
        const splashMat = new THREE.MeshStandardMaterial({
          color: 0xdfeff5, roughness: 1, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
        });
        const splash = new THREE.Mesh(new THREE.RingGeometry(ventR * 0.95, ventR * 1.7, 20), splashMat);
        // Lie the splash collar ON the local slope: a horizontal ring on rolling
        // ground sliced through the hill and read as a big white lens.
        const ventSeat = seatDecor(gx, gz, ventR * 1.6, 0.5);
        splash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ventSeat.normal);
        splash.position.set(gx, gy + 0.16, gz);
        splash.renderOrder = 2;
        group.add(splash);
        this.ctx.pushVolcanicFx((_dt, wt, cam) => {
          const far = cam.distanceTo(islandCenter) > cullRadius;
          idleSteam.visible = !far;
          if (far) { plume.visible = false; splash.visible = false; return; }
          const level = geyserEruptionLevel(geyser, wt);
          // Idle wisps: always drifting, fading out as the real jet takes over.
          idleMat.opacity = 0.17 * (1 - Math.min(1, level * 2.5));
          for (let i = 0; i < idleCount; i++) {
            const f = (idlePhase[i] + wt * 0.11) % 1;
            idlePos[i * 3] = gx + Math.cos(idleAng[i] + f * 1.6) * ventR * (0.25 + f * 0.9);
            idlePos[i * 3 + 1] = gy + 0.25 + f * (2.6 + ventR);
            idlePos[i * 3 + 2] = gz + Math.sin(idleAng[i] + f * 1.6) * ventR * (0.25 + f * 0.9);
          }
          idleGeo.attributes.position.needsUpdate = true;
          if (level <= 0.01) { plume.visible = false; splash.visible = false; ventCore.scale.setScalar(1); return; }
          plume.visible = true;
          splash.visible = true;
          mat.opacity = 0.85 * level;
          splashMat.opacity = 0.26 * level;
          splash.scale.setScalar(0.7 + level * 0.8);
          ventCore.scale.setScalar(1 + level * 0.4);
          const h = plumeH * level;
          for (let i = 0; i < plumeCount; i++) {
            const f = (phase[i] + wt * 0.85) % 1; // rise up the column, looping
            // Tight at the throat, blooming into a mushroom head near the top —
            // a jet, not the old evenly-scattered cloud of fat dots.
            const spread = geyser.radius * (0.12 + Math.pow(f, 2.4) * 1.9);
            pos[i * 3] = gx + Math.cos(ang[i] + f * 2.2) * spread;
            pos[i * 3 + 1] = gy + f * h;
            pos[i * 3 + 2] = gz + Math.sin(ang[i] + f * 2.2) * spread;
          }
          geo.attributes.position.needsUpdate = true;
        });
      }
    }

    // ── Waterfalls — every tall island earns cascades (SoT reference: white
    // ribbons pouring off the rock with mist at the base). Mountains get two
    // falls on opposite shoulders; tall plateaus one.
    const fallCount = island.profile.terrainStyle === 'mountain' ? 2
      : (island.profile.terrainStyle === 'plateau' || island.profile.terrainStyle === 'twin') ? 1
        : 0;
    for (let fall = 0; fall < fallCount; fall++) {
      const fallAngle = island.profile.ridgeAxis
        + Math.PI * (fall === 0 ? 0.5 : -0.55)
        + (rng(islandSeed * 47 + fall * 131) - 0.5) * 0.4;
      // Find the STEEPEST short segment along this heading (a real cliff lip) so
      // the ribbon hangs ~vertically off it. The old fixed 0.3→0.94 span was a
      // 30m+ mostly-horizontal reach that drew the fall as a flat white bar lying
      // across the island (worst on low plateaus).
      // AUDIT REGRESSION (floating-props P1): zero waterfalls existed scene-wide.
      // The old scan started at d=0.32 with a steepness ratio of 0.6, but the
      // post-relief mountain spires are steepest NEAR THE PEAK (small distRatio)
      // and their grade rarely exceeds 0.45 over a 0.12 span. Consciously
      // loosened: scan from d=0.06 and accept ratio > 0.32, keeping the drop>4
      // gate below so only a genuine cascade spawns. Also sweeps a few headings
      // around the nominal angle and keeps the best — one fixed bearing could
      // land on the island's gentle flank and find nothing.
      let lip = surfacePoint(0.3, fallAngle);
      let toe = surfacePoint(0.42, fallAngle);
      // Two passes: take a genuinely sheer face if one exists, and only fall
      // back to the loosened threshold when the island has none (otherwise a
      // 20-degree grass slope wins the search and the "cascade" is a stream).
      for (const minRatio of [0.75, 0.32]) {
        let bestScore = -1;
        for (let a = -3; a <= 3; a++) {
          const scanAngle = fallAngle + a * 0.16;
          for (let d = 0.06; d <= 0.86; d += 0.04) {
            const hi = surfacePoint(d, scanAngle);
            const lo = surfacePoint(d + 0.12, scanAngle);
            const dr = hi.y - lo.y;
            const horiz = Math.hypot(lo.x - hi.x, lo.z - hi.z);
            const ratio = dr / Math.max(0.1, horiz);
            const score = dr * ratio;
            if (ratio > minRatio && score > bestScore) { bestScore = score; lip = hi; toe = lo; }
          }
        }
        if (bestScore > 0 && lip.y - toe.y > 4) break;
      }
      // The sheet falls vertically from the lip, landing near the cliff base
      // (only a little outward), so it reads as a plunging cascade.
      const upper = lip;
      const lower = {
        x: lip.x + (toe.x - lip.x) * 0.35,
        y: toe.y,
        z: lip.z + (toe.z - lip.z) * 0.35,
      };
      const drop = upper.y - lower.y;
      if (drop > 4) {
        const fallMat = new THREE.MeshStandardMaterial({
          color: 0xc7e6f4,
          emissive: 0xb8e0f5,
          emissiveIntensity: 0.06, // falls catch the sky, they don't self-glow at night
          roughness: 0.4,
          transparent: true,
          opacity: 0.62,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        // Ribbons that HUG the rock face: at each height step, march outward
        // along the fall heading until the terrain drops below that height, and
        // stand the sheet a few centimetres proud of the face. A single flat
        // quad from lip to toe hangs in open air whenever the face is concave.
        const ribbons = lowDetail ? 2 : 3;
        const vSteps = lowDetail ? 5 : 10;
        const dxFall = lower.x - upper.x;
        const dzFall = lower.z - upper.z;
        const horizFall = Math.hypot(dxFall, dzFall);
        const dirX = horizFall > 0.001 ? dxFall / horizFall : 1;
        const dirZ = horizFall > 0.001 ? dzFall / horizFall : 0;
        const wAxisX = -dirZ;
        const wAxisZ = dirX;
        /** Horizontal reach at which the rock face has fallen to height `y`.
         *  Finely marched and MONOTONIC — a coarse march made the sheet
         *  zig-zag across the slope in visible sawtooth steps. */
        const marchSteps = 48;
        const maxS = Math.max(6, horizFall * 2.4);
        const profileY: number[] = [];
        for (let k = 0; k <= marchSteps; k++) {
          const cand = (k / marchSteps) * maxS;
          profileY.push(getIslandSurfaceY(
            island,
            upper.x + dirX * cand + island.position.x,
            upper.z + dirZ * cand + island.position.z,
          ));
        }
        const faceReach = (y: number): number => {
          for (let k = 1; k <= marchSteps; k++) {
            if (profileY[k] <= y) {
              const span = Math.max(1e-4, profileY[k - 1] - profileY[k]);
              const frac = THREE.MathUtils.clamp((profileY[k - 1] - y) / span, 0, 1);
              return ((k - 1 + frac) / marchSteps) * maxS;
            }
          }
          return maxS;
        };
        const toeReach = faceReach(lower.y);
        // All ribbons of one fall live in a single geometry — 4 separate meshes
        // per cascade was 4 draw calls for one visual object.
        const corners: number[] = [];
        const idx: number[] = [];
        for (let rib = 0; rib < ribbons; rib++) {
          const t = rib / Math.max(1, ribbons - 1);
          const lateral = (t - 0.5) * 3.6;
          const ribbonW = 1.0 + rng(rib * 711) * 0.55;
          const ribBase = corners.length / 3;
          for (let v = 0; v <= vSteps; v++) {
            const f = v / vSteps;
            const y = upper.y - drop * f;
            // Stand the sheet on the rock FACE, lifted clear of it: the sheet
            // sits at the horizontal reach where the ground is at height `y`,
            // then floats 0.7m above that. On a sheer face faceReach() barely
            // moves with height, so the sheet is vertical (a plunging cascade);
            // on a graded face it becomes a chute hugging the slope. Dropping
            // straight down from the lip instead buried 80% of the sheet inside
            // the hill on every non-overhanging face (seen in verification).
            const reach = faceReach(y) + 0.35;
            const cx = upper.x + dirX * reach + wAxisX * lateral;
            const cz = upper.z + dirZ * reach + wAxisZ * lateral;
            const sheetY = y + 0.45;
            // Width wobbles down the drop so the chute reads as moving water
            // rather than a straight-edged plastic strip.
            const wob = 1 + Math.sin(f * 7.5 + rib * 2.1) * 0.22 + Math.sin(f * 17.0 + rib) * 0.1;
            const halfW = ribbonW * (0.6 + f * 0.4) * wob * 0.5;   // widens as it falls
            corners.push(cx + wAxisX * halfW, sheetY, cz + wAxisZ * halfW);
            corners.push(cx - wAxisX * halfW, sheetY, cz - wAxisZ * halfW);
            if (v > 0) {
              const a0 = ribBase + (v - 1) * 2;
              idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
            }
          }
        }
        {
          const ribbonGeo = new THREE.BufferGeometry();
          ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
          ribbonGeo.setIndex(idx);
          ribbonGeo.computeVertexNormals();
          const ribbon = new THREE.Mesh(ribbonGeo, fallMat);
          ribbon.name = 'waterfall-ribbon';
          group.add(ribbon);
        }
        // Plunge pool where the sheet lands (lit, NOT self-glowing: a Basic
        // material renders full white at midnight and made the pool a lamp).
        const poolReach = toeReach + 1.2;
        const poolX = upper.x + dirX * poolReach;
        const poolZ = upper.z + dirZ * poolReach;
        const poolY = getIslandSurfaceY(island, poolX + island.position.x, poolZ + island.position.z);
        const poolSeat = seatDecor(poolX, poolZ, 1.6, 0.5);
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(1.5, 18),
          new THREE.MeshStandardMaterial({
            color: 0xdff1f8, roughness: 0.2, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        // Lie the pool ON the slope: a flat disc dropped on a hillside cuts a
        // hard white ellipse half-buried in the rock.
        pool.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), poolSeat.normal);
        pool.position.set(poolX, poolY + 0.07, poolZ);
        pool.renderOrder = 2;
        group.add(pool);
        // Mist billowing off the plunge point.
        if (!lowDetail) {
          // Soft alpha sprites, not shaded spheres: overlapping low-poly balls
          // stacked their alpha into hard white blobs at the fall's base.
          const mistCount = 14;
          const mistPos = new Float32Array(mistCount * 3);
          for (let m = 0; m < mistCount; m++) {
            mistPos[m * 3] = poolX + (rng(m * 717) - 0.5) * 3.0;
            mistPos[m * 3 + 1] = poolY + 0.3 + rng(m * 721) * 2.6;
            mistPos[m * 3 + 2] = poolZ + (rng(m * 723) - 0.5) * 3.0;
          }
          const mistGeo = new THREE.BufferGeometry();
          mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPos, 3));
          const mist = new THREE.Points(mistGeo, new THREE.PointsMaterial({
            size: 2.6,
            map: this.ctx.getSoftParticleTexture(),
            color: 0xccdde5,
            transparent: true,
            opacity: 0.17,
            depthWrite: false,
          }));
          mist.frustumCulled = false;
          group.add(mist);
        }
        lower.x = poolX;
        lower.z = poolZ;
        lower.y = poolY;
        // Add a stream channel — darker dirt strip from base toward the shore
        const streamSteps = 6;
        const streamMat = new THREE.MeshStandardMaterial({ color: 0x4a6478, roughness: 0.6, emissive: 0x224050, emissiveIntensity: 0.2 });
        for (let st = 0; st < streamSteps; st++) {
          const t = st / streamSteps;
          const sx = lower.x + (lower.x * 0.06) * t;
          const sz = lower.z + (lower.z * 0.06) * t;
          const sy = getIslandSurfaceY(island, sx + island.position.x, sz + island.position.z);
          if (sy < 5.2) continue;
          const seg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.8), streamMat);
          seg.position.set(sx, sy + 0.03, sz);
          group.add(seg);
        }
      }
    }

    // ── Layered cliff strata — exposed rock bands wrapping high cliffs ──
    // (skipped on mountains: the sheer spires changed the slopes those slabs
    // were sampled against, leaving them floating mid-air)
    if (island.profile.heightProfile > 0.35 && !lowDetail && island.profile.terrainStyle !== 'mountain') {
      const strataMats = [
        new THREE.MeshStandardMaterial({ color: 0x6a5d48, roughness: 1, flatShading: true }),
        new THREE.MeshStandardMaterial({ color: 0x564b3a, roughness: 1, flatShading: true }),
        new THREE.MeshStandardMaterial({ color: 0x46402f, roughness: 1, flatShading: true }),
      ];
      const bandCount = Math.min(4, 2 + Math.floor(island.profile.heightProfile * 4));
      for (let band = 0; band < bandCount; band++) {
        const h01 = 0.45 + (band / bandCount) * 0.4;
        const segCount = scaledCount(8 + band * 2, 6);
        for (let s = 0; s < segCount; s++) {
          const angle = (s / segCount) * Math.PI * 2 + rng(band * 731 + s * 11) * 0.4;
          const distRatio = 0.42 + rng(band * 737 + s * 13) * 0.22;
          const pt = surfacePoint(distRatio, angle, 0);
          if (!isSolidDecorPoint(pt, SURFACE_ABOVE_WATER, -0.2)) continue;
          const slabH = 0.35 + rng(band * 741 + s) * 0.45;
          const slab = new THREE.Mesh(
            new THREE.BoxGeometry(1.5 + rng(band * 743 + s) * 1.2, slabH, 0.5 + rng(band * 747 + s) * 0.6),
            strataMats[band % strataMats.length],
          );
          slab.position.copy(pt);
          slab.position.y += h01 * 0.4;
          slab.rotation.set(
            (rng(band * 751 + s) - 0.5) * 0.18,
            angle + Math.PI * 0.5 + (rng(band * 753 + s) - 0.5) * 0.3,
            (rng(band * 757 + s) - 0.5) * 0.16,
          );
          slab.castShadow = true;
          slab.receiveShadow = true;
          group.add(slab);
        }
      }
    }

    // (Procedural stone arch removed — rock_arch is a real Blender GLB
    // placed by the server prop registry now.)

    // ── Lookout post — wooden tower on or near a high point ──
    if (!lowDetail && r > 40) {
      const lookout = new THREE.Group();
      const angle = island.profile.primaryHillAngle + (rng(islandSeed * 83) - 0.5) * 0.6;
      const distRatio = 0.18 + rng(islandSeed * 89) * 0.18;
      const base = surfacePoint(distRatio, angle, 0);
      lookout.position.set(base.x, base.y, base.z);
      const towerYaw = rng(islandSeed * 97) * Math.PI * 2;
      lookout.rotation.y = towerYaw;
      const towerMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 });
      const beamMat = new THREE.MeshStandardMaterial({ color: 0x2d1d0e, roughness: 1 });
      const towerH = 4.2 + rng(islandSeed * 101) * 1.6;
      // Find the highest leg base so we know how to extend the others
      const legOffset = 0.7;
      const legPositions: { sx: number; sz: number; surfaceY: number }[] = [];
      const cosY = Math.cos(towerYaw);
      const sinY = Math.sin(towerYaw);
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          // Local (sx*0.7, sz*0.7) in lookout space → world position
          const wx = base.x + island.position.x + (sx * legOffset * cosY + sz * legOffset * sinY);
          const wz = base.z + island.position.z + (-sx * legOffset * sinY + sz * legOffset * cosY);
          const wy = getIslandSurfaceY(island, wx, wz);
          legPositions.push({ sx, sz, surfaceY: wy });
        }
      }
      const minSurface = Math.min(...legPositions.map((p) => p.surfaceY));
      const platformY = Math.max(...legPositions.map((p) => p.surfaceY)) + towerH;
      // Anchor lookout group at the lowest leg base so all positions are >= 0 in local
      lookout.position.y = minSurface;
      // Legs extend from each ground point up to the platform
      for (const { sx, sz, surfaceY } of legPositions) {
        const localBaseY = surfaceY - minSurface;
        const localTopY = platformY - minSurface;
        const legH = localTopY - localBaseY;
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, legH, 0.18), towerMat);
        leg.position.set(sx * legOffset, localBaseY + legH * 0.5, sz * legOffset);
        leg.castShadow = true;
        lookout.add(leg);
      }
      const platformLocalY = platformY - minSurface;
      // Cross braces
      for (const sz of [-1, 1] as const) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.1), beamMat);
        brace.position.set(0, platformLocalY * 0.5, sz * 0.7);
        brace.rotation.z = sz * 0.6;
        lookout.add(brace);
      }
      // Platform
      const deck = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 2.0), towerMat);
      deck.position.y = platformLocalY;
      deck.castShadow = true;
      deck.receiveShadow = true;
      lookout.add(deck);
      // Railings
      for (const sx of [-1, 1] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 2.0), beamMat);
        rail.position.set(sx * 0.94, platformLocalY + 0.55, 0);
        lookout.add(rail);
      }
      for (const sz of [-1, 1] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, 0.08), beamMat);
        rail.position.set(0, platformLocalY + 0.55, sz * 0.94);
        lookout.add(rail);
      }
      // Flag
      const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), beamMat);
      flagPole.position.set(0.6, platformLocalY + 1.25, 0.6);
      lookout.add(flagPole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.0, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x6e1313, roughness: 0.95, side: THREE.DoubleSide }),
      );
      flag.position.set(1.1, platformLocalY + 2.1, 0.6);
      lookout.add(flag);
      // Ladder up the front (anchored at the front-corner leg's base)
      const frontLeg = legPositions.find((p) => p.sz === 1) ?? legPositions[0];
      const ladderBase = frontLeg.surfaceY - minSurface;
      const ladderTop = platformLocalY;
      const rungCount = Math.max(6, Math.floor((ladderTop - ladderBase) / 0.45));
      for (let rung = 0; rung < rungCount; rung++) {
        const ry = ladderBase + 0.2 + rung * (ladderTop - ladderBase - 0.4) / Math.max(1, rungCount - 1);
        const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.06), towerMat);
        r2.position.set(0, ry, 0.92);
        lookout.add(r2);
      }
      void towerH;
      if (isSolidDecorPoint(base, SURFACE_ABOVE_WATER, -0.2)) group.add(lookout);
    }

    // ── Pirate camp — fire pit, bedrolls, totem, hung skull ──
    if (!lowDetail && r > 38) {
      const camp = new THREE.Group();
      const angle = island.profile.secondaryHillAngle + (rng(islandSeed * 113) - 0.5) * 0.8;
      const distRatio = 0.28 + rng(islandSeed * 127) * 0.24;
      const base = surfacePoint(distRatio, angle, 0);
      const campYaw = rng(islandSeed * 131) * Math.PI * 2;
      camp.position.copy(base);
      camp.rotation.y = campYaw;
      const cosCY = Math.cos(campYaw);
      const sinCY = Math.sin(campYaw);
      const groundOffsetAt = (lx: number, lz: number) => {
        // Convert local camp coords back to world to sample terrain Y
        const wx = base.x + island.position.x + (lx * cosCY + lz * sinCY);
        const wz = base.z + island.position.z + (-lx * sinCY + lz * cosCY);
        return getIslandSurfaceY(island, wx, wz) - base.y;
      };
      const stoneMatC = new THREE.MeshStandardMaterial({ color: 0x3d352b, roughness: 1 });
      const charredMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 1, emissive: 0x6b2a06, emissiveIntensity: 0.4 });
      const logMatC = new THREE.MeshStandardMaterial({ color: 0x2a1a0c, roughness: 1 });
      // Fire pit: GLB stone ring + charred logs when available (interim — a
      // later pass moves camp placement to the server prop registry).
      const campfireGlb = this.buildPropInstance(
        'campfire',
        new THREE.Vector3(0, 0.02, 0),
        rng(islandSeed * 151) * Math.PI * 2,
        1.15,
      );
      if (campfireGlb) {
        camp.add(campfireGlb);
      } else {
        // Fire ring — each stone seated on the terrain under it (the flat 0.18
        // ring floated on the downhill side of a sloped campsite).
        for (let s = 0; s < 8; s++) {
          const a = (s / 8) * Math.PI * 2;
          const stone = new THREE.Mesh(boulderGeo, stoneMatC);
          const slx = Math.cos(a) * 0.8;
          const slz = Math.sin(a) * 0.8;
          stone.position.set(slx, groundOffsetAt(slx, slz) + 0.14, slz);
          stone.scale.setScalar(0.22 + rng(s * 137) * 0.15);
          stone.rotation.set(rng(s * 139) * Math.PI, rng(s * 143) * Math.PI, rng(s * 149) * Math.PI);
          camp.add(stone);
        }
        // Logs criss-crossed
        for (let l = 0; l < 4; l++) {
          const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.2, 5), logMatC);
          log.rotation.z = Math.PI * 0.5;
          log.rotation.y = (l / 4) * Math.PI;
          log.position.set(0, 0.18, 0);
          camp.add(log);
        }
      }
      // Glowing embers (the in-engine "flame" over the GLB fire pit)
      const embers = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), charredMat);
      embers.position.y = 0.22;
      camp.add(embers);
      // Campfire light + flame sprite via the night-budget system (keeps a small
      // day-time flame; a strong flickering PointLight lights it at night).
      this.ctx.registerLanternEmitter(camp, 0, 0.42, 0, 'campfire');

      // Bedrolls
      const bedMat = new THREE.MeshStandardMaterial({ color: 0x6b3823, roughness: 0.95 });
      for (let b = 0; b < 2; b++) {
        const bedAngle = b === 0 ? 1.3 : -1.3;
        const bedLx = Math.cos(bedAngle) * 1.7;
        const bedLz = Math.sin(bedAngle) * 1.7;
        const bedY = groundOffsetAt(bedLx, bedLz);
        const bed = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.22, 0.6), bedMat);
        bed.position.set(bedLx, bedY + 0.12, bedLz);
        bed.rotation.y = -bedAngle + Math.PI * 0.5;
        bed.castShadow = true;
        camp.add(bed);
        const pillowLx = Math.cos(bedAngle) * 2.2;
        const pillowLz = Math.sin(bedAngle) * 2.2;
        const pillowY = groundOffsetAt(pillowLx, pillowLz);
        const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 1 }));
        pillow.position.set(pillowLx, pillowY + 0.18, pillowLz);
        pillow.rotation.y = -bedAngle + Math.PI * 0.5;
        camp.add(pillow);
      }
      // Totem with skull — ground its base
      const totemY = groundOffsetAt(-2.2, 0.6);
      const totem = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.4, 6), logMatC);
      totem.position.set(-2.2, totemY + 1.2, 0.6);
      totem.castShadow = true;
      camp.add(totem);
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe8dec2, roughness: 0.85 }));
      skull.position.set(-2.2, totemY + 2.55, 0.6);
      camp.add(skull);
      // Two black eyes
      for (const sx of [-1, 1] as const) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        eye.position.set(-2.2 + sx * 0.07, totemY + 2.58, 0.78);
        camp.add(eye);
      }
      // Cookpot — sits on the ground next to fire
      const potY = groundOffsetAt(1.4, 0.4);
      const potMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, metalness: 0.4 });
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.5, 10), potMat);
      pot.position.set(1.4, potY + 0.34, 0.4);
      pot.castShadow = true;
      camp.add(pot);
      // Tripod over fire
      for (let t = 0; t < 3; t++) {
        const a = (t / 3) * Math.PI * 2;
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.6, 4), logMatC);
        stick.position.set(Math.cos(a) * 0.8, 0.8, Math.sin(a) * 0.8);
        stick.rotation.x = Math.cos(a) * 0.5;
        stick.rotation.z = Math.sin(a) * 0.5;
        camp.add(stick);
      }
      if (isSolidDecorPoint(base, SURFACE_ABOVE_WATER, -0.2)) group.add(camp);
    }

    // ── Rock cairns scattered along higher ground ──
    if (!lowDetail) {
      const cairnCount = scaledCount(2 + Math.round(r / 50), 1);
      for (let i = 0; i < cairnCount; i++) {
        const angle = rng(i * 311 + 17) * Math.PI * 2;
        const distRatio = 0.3 + rng(i * 313 + 19) * 0.3;
        const base = surfacePoint(distRatio, angle, 0);
        if (base.y < 5.6 || !isSolidDecorPoint(base, 5.6, -0.2)) continue;
        const cairn = new THREE.Group();
        cairn.position.copy(base);
        cairn.position.y -= seatDecor(base.x, base.z, 0.4).drop;
        const stoneCount = 3 + Math.floor(rng(i * 317) * 2);
        let yOff = 0;
        for (let s = 0; s < stoneCount; s++) {
          const stone = new THREE.Mesh(boulderGeo, boulderMat);
          const sc = 0.42 - s * 0.06 + rng(s * 319 + i) * 0.06;
          stone.scale.setScalar(sc);
          yOff += sc * 0.7;
          stone.position.set((rng(s * 323 + i) - 0.5) * 0.06, yOff, (rng(s * 329 + i) - 0.5) * 0.06);
          stone.rotation.set(rng(s * 331 + i) * Math.PI, rng(s * 337 + i) * Math.PI, rng(s * 341 + i) * Math.PI);
          stone.castShadow = true;
          cairn.add(stone);
        }
        group.add(cairn);
      }
    }

    // NOTE: the client-only bedrock CRAG mass generator that used to live here
    // was removed — crags are now authored props in the SERVER registry and
    // render automatically through buildServerProps(). Rebuilding them here as
    // well produced doubled, mismatched outcrops on every mountain/rocky isle.

    // ── Pebbles + rock chips: one InstancedMesh of ankle-height stones ──
    // The ground had NOTHING between 8m props and painted colour; a scatter of
    // sub-20cm stones gives the eye real scale reference at 2m. Zero colliders,
    // one draw call, culled with the rest of the island group.
    if (!lowDetail) {
      const pebbleCount = Math.min(1400, Math.round(r * (visualDetail < 0.85 ? 2.4 : 4.2)));
      const pebbleGeo = new THREE.DodecahedronGeometry(1, 0);
      const pebbleMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true, vertexColors: false });
      const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, pebbleCount);
      const pMat4 = new THREE.Matrix4();
      const pPos = new THREE.Vector3();
      const pQuat = new THREE.Quaternion();
      const pEuler = new THREE.Euler();
      const pScale = new THREE.Vector3();
      const pColor = new THREE.Color();
      let placed = 0;
      for (let i = 0; i < pebbleCount * 2 && placed < pebbleCount; i++) {
        const angle = rng(i * 907 + 31) * Math.PI * 2;
        // Weight toward the mid/upper flanks and the rocky shore band.
        const distRatio = rng(i * 911 + 7) < 0.72
          ? 0.12 + rng(i * 919 + 3) * 0.62
          : 0.9 + rng(i * 929 + 5) * 0.12;
        const p = surfacePoint(distRatio, angle, 0);
        if (!isSolidDecorPoint(p, 4.4, -0.1)) continue;
        const s = 0.05 + rng(i * 937) * 0.14;
        pPos.set(p.x, p.y - s * 0.35, p.z);
        pEuler.set(rng(i * 941) * Math.PI, rng(i * 947) * Math.PI, rng(i * 953) * Math.PI);
        pQuat.setFromEuler(pEuler);
        pScale.set(s * (0.8 + rng(i * 967) * 0.7), s * (0.5 + rng(i * 971) * 0.5), s * (0.8 + rng(i * 977) * 0.6));
        pMat4.compose(pPos, pQuat, pScale);
        pebbles.setMatrixAt(placed, pMat4);
        pColor.copy(paletteRock).multiplyScalar(0.72 + rng(i * 983) * 0.5);
        pebbles.setColorAt(placed, pColor);
        placed++;
      }
      if (placed === 0) {
        pebbles.geometry.dispose();
        pebbleMat.dispose();
      } else {
        pebbles.count = placed;
        pebbles.instanceMatrix.needsUpdate = true;
        if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
        pebbles.castShadow = false;
        pebbles.receiveShadow = true;
        group.add(pebbles);
      }
    }

    // ── Interior dressing: the biggest islands read as empty green domes with
    // a handful of props on them (audit: Castaway Reach / Rumrunner Key /
    // Gallows Sands mids). Fill the dead band between the shore ring and the
    // peak with boulder clusters, fallen trunks and low scrub beds. Client
    // decor only — the server registry and its RNG are untouched.
    if (!lowDetail && r > 36) {
      // Gate at r>36 (not 58): the audit's three barren interiors were Castaway
      // Reach (r=88) but also Rumrunner Key (42) and Gallows Sands (38).
      const interiorSites = scaledCount(Math.round((r - 28) / 4.5), 2);
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b563a, roughness: 1 });
      // Instanced buckets: this dressing runs on the biggest islands, and one
      // draw call per stone would have added ~50 calls per island. Boulders
      // reuse the shared decor geo; scrub reuses the real `bush` GLB (an
      // untextured icosphere read as a green gem in review).
      const bushAsset = assets.mergedGeometry('bush');
      const logAsset = assets.mergedGeometry('driftwood_log');
      const logObj = new THREE.Object3D();
      const stoneXf: THREE.Matrix4[] = [];
      const bushXf: THREE.Matrix4[] = [];
      const logXf: THREE.Matrix4[] = [];
      const xfPos = new THREE.Vector3();
      const xfQuat = new THREE.Quaternion();
      const xfEuler = new THREE.Euler();
      const xfScale = new THREE.Vector3();
      for (let i = 0; i < interiorSites; i++) {
        // Golden-angle spiral so sites spread over the whole interior instead of
        // clumping the way a plain random pair does.
        const angle = i * 2.399963 + rng(i * 601 + 13) * 0.8;
        const distRatio = 0.18 + ((i * 0.37) % 1) * 0.42 + (rng(i * 607 + 3) - 0.5) * 0.08;
        const base = surfacePoint(distRatio, angle, 0);
        if (base.y < 6 || !isSolidDecorPoint(base, 6, -0.25)) continue;
        const kind = rng(i * 613 + 5);
        if (kind < 0.42) {
          // Boulder cluster: 2-4 stones half-buried, leaning into the slope.
          const stones = 2 + Math.floor(rng(i * 617) * 3);
          for (let s = 0; s < stones; s++) {
            const ox = (rng(s * 619 + i) - 0.5) * 3.4;
            const oz = (rng(s * 631 + i) - 0.5) * 3.4;
            const sc = 0.5 + rng(s * 641 + i) * 1.5;
            const seat = seatDecor(base.x + ox, base.z + oz, sc, 0.6);
            xfPos.set(base.x + ox, seat.groundY - seat.drop - sc * 0.34, base.z + oz);
            xfEuler.set((rng(s * 659 + i) - 0.5) * 0.7, rng(s * 661 + i) * Math.PI, (rng(s * 673 + i) - 0.5) * 0.7);
            xfQuat.setFromEuler(xfEuler);
            xfScale.set(sc * (0.8 + rng(s * 643 + i) * 0.6), sc * (0.6 + rng(s * 647 + i) * 0.5), sc * (0.8 + rng(s * 653 + i) * 0.6));
            stoneXf.push(new THREE.Matrix4().compose(xfPos, xfQuat, xfScale));
          }
        } else if (kind < 0.68) {
          // Fallen trunk lying along the contour. Prefer the authored log GLB:
          // a 7-sided procedural cylinder read as a dark rectangular plank from
          // any distance (caught in verification).
          const trunkScale = 1.5 + rng(i * 677) * 1.4;
          const seat = seatDecor(base.x, base.z, trunkScale * 1.2, 0.5);
          const logY = seat.groundY - seat.drop;
          if (logAsset) {
            logObj.position.set(base.x, logY - 0.06, base.z);
            logObj.rotation.set(0, rng(i * 691) * Math.PI * 2, (rng(i * 701) - 0.5) * 0.2);
            logObj.scale.setScalar(trunkScale);
            logObj.updateMatrix();
            logXf.push(logObj.matrix.clone());
          } else {
            const trunkLen = 2.6 + rng(i * 677) * 3.4;
            const trunkR = 0.22 + rng(i * 683) * 0.18;
            const trunk = new THREE.Mesh(new THREE.CylinderGeometry(trunkR * 0.8, trunkR, trunkLen, 9), trunkMat);
            trunk.position.set(base.x, logY + trunkR * 0.55, base.z);
            trunk.rotation.set(Math.PI * 0.5, rng(i * 691) * Math.PI * 2, (rng(i * 701) - 0.5) * 0.25);
            trunk.castShadow = true;
            trunk.receiveShadow = true;
            group.add(trunk);
          }
        } else {
          // Low scrub bed — a knot of 3-6 squat bushes.
          const bushes = 3 + Math.floor(rng(i * 709) * 4);
          for (let b = 0; b < bushes; b++) {
            const ox = (rng(b * 719 + i) - 0.5) * 4.2;
            const oz = (rng(b * 727 + i) - 0.5) * 4.2;
            const sc = 0.6 + rng(b * 733 + i) * 0.7;
            const gy = getIslandSurfaceY(island, base.x + ox + island.position.x, base.z + oz + island.position.z);
            xfPos.set(base.x + ox, gy - 0.08, base.z + oz);
            xfEuler.set(0, rng(b * 739 + i) * Math.PI * 2, 0);
            xfQuat.setFromEuler(xfEuler);
            xfScale.set(sc, sc * (0.8 + rng(b * 743 + i) * 0.4), sc);
            bushXf.push(new THREE.Matrix4().compose(xfPos, xfQuat, xfScale));
          }
        }
      }
      if (stoneXf.length) {
        const stoneInst = new THREE.InstancedMesh(boulderGeo, boulderMat, stoneXf.length);
        stoneXf.forEach((m, k) => stoneInst.setMatrixAt(k, m));
        stoneInst.instanceMatrix.needsUpdate = true;
        stoneInst.castShadow = true;
        stoneInst.receiveShadow = true;
        group.add(stoneInst);
      }
      if (logXf.length && logAsset) {
        const logInst = new THREE.InstancedMesh(logAsset.geometry, logAsset.material, logXf.length);
        logXf.forEach((m, k) => logInst.setMatrixAt(k, m));
        logInst.instanceMatrix.needsUpdate = true;
        logInst.castShadow = true;
        logInst.receiveShadow = true;
        group.add(logInst);
      }
      if (bushXf.length && bushAsset) {
        this.applyFoliageSway(bushAsset.material);
        const bushInst = new THREE.InstancedMesh(bushAsset.geometry, bushAsset.material, bushXf.length);
        bushXf.forEach((m, k) => bushInst.setMatrixAt(k, m));
        bushInst.instanceMatrix.needsUpdate = true;
        bushInst.castShadow = false;
        bushInst.receiveShadow = true;
        group.add(bushInst);
      }
    }

    // ── Banana trees — short fat-trunked palms with hanging fruit ──
    if (r > 38) {
      const bananaCount = scaledCount(Math.round(r / 36), 1);
      const bananaTrunkMat = new THREE.MeshStandardMaterial({ color: 0x6c4d2a, roughness: 1 });
      const bananaLeafMat = new THREE.MeshStandardMaterial({ color: 0x4ea832, roughness: 0.85, side: THREE.DoubleSide });
      const bananaFruitMat = new THREE.MeshStandardMaterial({ color: 0xeacf3a, roughness: 0.7 });
      for (let i = 0; i < bananaCount; i++) {
        const angle = rng(i * 351 + 23) * Math.PI * 2;
        const distRatio = 0.18 + rng(i * 357) * 0.34;
        const pos = surfacePoint(distRatio, angle, 0);
        const bananaHeightCap = 5.15 + island.radius * 0.0085 + island.radius * 0.085 * (1 + (island.profile.peakBoost ?? 0) * 0.3);
        if (pos.y > bananaHeightCap) continue;
        if (!isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) continue;
        const tree = new THREE.Group();
        tree.position.copy(pos);
        const trunkH = 1.8 + rng(i * 359) * 1.0;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, trunkH, 6), bananaTrunkMat);
        trunk.position.y = trunkH * 0.5;
        trunk.castShadow = true;
        tree.add(trunk);
        // 6 broad drooping leaves
        for (let l = 0; l < 6; l++) {
          const la = (l / 6) * Math.PI * 2;
          const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.6), bananaLeafMat);
          leaf.position.set(Math.cos(la) * 0.5, trunkH + 0.1, Math.sin(la) * 0.5);
          leaf.rotation.set(-0.5, la, 0);
          tree.add(leaf);
        }
        // Fruit cluster
        if (rng(i * 363) > 0.4) {
          for (let f = 0; f < 5; f++) {
            const fruit = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 5), bananaFruitMat);
            fruit.rotation.z = Math.PI * 0.5;
            fruit.rotation.y = (f / 5) * 0.6 - 0.3;
            fruit.position.set(0.2 + f * 0.04, trunkH - 0.15, 0.12 + (f - 2) * 0.06);
            tree.add(fruit);
          }
        }
        group.add(tree);
      }
    }

    // ── Dead/weathered trees — bone-grey snags ──
    {
      const deadCount = scaledCount(Math.round(r / 52), 0);
      const deadMat = new THREE.MeshStandardMaterial({ color: 0xa19684, roughness: 1 });
      for (let i = 0; i < deadCount; i++) {
        const angle = rng(i * 367 + 29) * Math.PI * 2;
        const distRatio = 0.32 + rng(i * 369) * 0.36;
        const pos = surfacePoint(distRatio, angle, 0);
        if (!isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) continue;
        const tree = new THREE.Group();
        tree.position.copy(pos);
        const trunkH = 2.6 + rng(i * 371) * 2.2;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, trunkH, 5), deadMat);
        trunk.rotation.z = (rng(i * 373) - 0.5) * 0.18;
        trunk.position.y = trunkH * 0.5;
        trunk.castShadow = true;
        tree.add(trunk);
        // Two-three angular branches
        const branchCount = 2 + Math.floor(rng(i * 377) * 2);
        for (let b = 0; b < branchCount; b++) {
          const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 1.0 + rng(b * 379 + i) * 0.8, 5), deadMat);
          const ba = rng(b * 381 + i) * Math.PI * 2;
          branch.position.set(Math.cos(ba) * 0.3, trunkH - 0.2 - b * 0.4, Math.sin(ba) * 0.3);
          branch.rotation.set(rng(b * 383 + i) * 0.6 + 0.4, ba, rng(b * 387 + i) * 0.4);
          tree.add(branch);
        }
        group.add(tree);
      }
    }

    // ── Mossy fallen log on the jungle floor ──
    if (!lowDetail && r > 40) {
      const logAngle = rng(islandSeed * 163) * Math.PI * 2;
      const pos = surfacePoint(0.32 + rng(islandSeed * 167) * 0.18, logAngle, 0);
      const log = new THREE.Group();
      log.position.copy(pos);
      log.rotation.y = rng(islandSeed * 173) * Math.PI * 2;
      const logMat = new THREE.MeshStandardMaterial({ color: 0x4d3a23, roughness: 1 });
      const mossMat = new THREE.MeshStandardMaterial({ color: 0x3a6b30, roughness: 0.9 });
      const length = 3.4 + rng(islandSeed * 179) * 2.0;
      const main = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, length, 8), logMat);
      main.rotation.z = Math.PI * 0.5;
      main.position.y = 0.3;
      main.castShadow = true;
      log.add(main);
      // Moss patches as small flattened spheres on top
      for (let m = 0; m < 5; m++) {
        const moss = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5), mossMat);
        moss.scale.set(1, 0.4, 1);
        moss.position.set((rng(m * 191 + islandSeed) - 0.5) * length * 0.7, 0.55, (rng(m * 193 + islandSeed) - 0.5) * 0.2);
        log.add(moss);
      }
      // Mushrooms — anchored on the ground next to the log (radius 0.32, log center y=0.3)
      const mushMat = new THREE.MeshStandardMaterial({ color: 0xc4534a, roughness: 0.9 });
      const mushStemMat = new THREE.MeshStandardMaterial({ color: 0xeae0c8, roughness: 0.95 });
      for (let s = 0; s < 3; s++) {
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.18, 5), mushStemMat);
        const localX = (rng(s * 197 + islandSeed) - 0.5) * length * 0.6;
        const sideZ = (rng(s * 199 + islandSeed) > 0.5 ? 1 : -1) * (0.42 + rng(s * 201 + islandSeed) * 0.12);
        stem.position.set(localX, 0.09, sideZ);
        log.add(stem);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), mushMat);
        cap.position.set(localX, 0.18, sideZ);
        log.add(cap);
      }
      if (isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) group.add(log);
    }

    // ── Beached dinghy — small wrecked rowboat in the dunes ──
    if (!lowDetail && r > 40) {
      const dinghyAngle = islandHeading + Math.PI * (rng(islandSeed * 217) > 0.5 ? 0.4 : -0.4);
      const pos = surfacePoint(0.86 + rng(islandSeed * 223) * 0.06, dinghyAngle, 0);
      const dinghy = new THREE.Group();
      dinghy.position.copy(pos);
      dinghy.rotation.y = -dinghyAngle + Math.PI * 0.5 + (rng(islandSeed * 229) - 0.5) * 0.5;
      dinghy.rotation.z = (rng(islandSeed * 233) - 0.5) * 0.4;
      const hullMat = new THREE.MeshStandardMaterial({ color: 0x4a2f17, roughness: 1 });
      // Hull halves — two box sides angled inward
      for (const sx of [-1, 1] as const) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 2.4), hullMat);
        side.position.set(sx * 0.42, 0.28, 0);
        side.rotation.z = sx * 0.32;
        side.castShadow = true;
        dinghy.add(side);
      }
      // Bottom
      const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 2.4), hullMat);
      bottom.position.y = 0.06;
      dinghy.add(bottom);
      // Bow & stern caps (triangular)
      for (const sz of [-1, 1] as const) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.12), hullMat);
        cap.position.set(0, 0.2, sz * 1.2);
        cap.rotation.x = sz * 0.2;
        dinghy.add(cap);
      }
      // Oar
      const oar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 1.4), hullMat);
      oar.position.set(0.3, 0.4, -0.3);
      oar.rotation.y = 0.4;
      dinghy.add(oar);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.04, 0.4), hullMat);
      blade.position.set(0.55, 0.4, -0.95);
      blade.rotation.y = 0.4;
      dinghy.add(blade);
      if (isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.15)) group.add(dinghy);
    }

    // ── Crab traps & fishing nets near the dock ──
    if (island.dock && !lowDetail) {
      const dock = island.dock;
      const ropeMatN = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
      const trapMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 });
      const netMat = new THREE.MeshStandardMaterial({ color: 0xb39c6a, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
      // Hanging fishing net on a frame next to the dock
      const netSideAngle = dock.shoreAngle + dock.moorSide * 0.95;
      const netPos = surfacePoint(0.86, netSideAngle, 0);
      const netGroup = new THREE.Group();
      netGroup.position.copy(netPos);
      // Net frame faces inland so the net spreads toward the dock approach
      netGroup.rotation.y = Math.atan2(-netPos.x, -netPos.z);
      // Frame: two posts + cross bar
      for (const sx of [-1, 1] as const) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 5), trapMat);
        post.position.set(sx * 0.9, 1.1, 0);
        post.castShadow = true;
        netGroup.add(post);
      }
      const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 5), trapMat);
      cross.rotation.z = Math.PI * 0.5;
      cross.position.set(0, 2.0, 0);
      netGroup.add(cross);
      // Net plane
      const net = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.6, 4, 4), netMat);
      net.position.set(0, 1.15, 0.04);
      netGroup.add(net);
      // Drying fish hung on the cross bar
      const fishMat = new THREE.MeshStandardMaterial({ color: 0xb6a37a, roughness: 0.9 });
      for (let f = 0; f < 3; f++) {
        const fish = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.36, 6), fishMat);
        fish.rotation.z = Math.PI * 0.5;
        fish.position.set(-0.6 + f * 0.6, 1.78, 0);
        netGroup.add(fish);
      }
      if (isSolidDecorPoint(netPos, SURFACE_ABOVE_WATER, -0.15)) group.add(netGroup);

      // Crab traps: 2-3 stacked baskets near the shore
      const trapAngle = dock.shoreAngle - dock.moorSide * 0.7;
      const trapBase = surfacePoint(0.84, trapAngle, 0);
      for (let t = 0; t < 3; t++) {
        if (!isSolidDecorPoint(trapBase, SURFACE_ABOVE_WATER, -0.15)) continue;
        const offX = (rng(t * 901 + islandSeed) - 0.5) * 1.2;
        const offZ = (rng(t * 907 + islandSeed) - 0.5) * 1.2;
        const trapWX = trapBase.x + island.position.x + offX;
        const trapWZ = trapBase.z + island.position.z + offZ;
        const trapY = getIslandSurfaceY(island, trapWX, trapWZ);
        const trap = new THREE.Group();
        trap.position.set(trapBase.x + offX, trapY, trapBase.z + offZ);
        trap.rotation.y = rng(t * 911 + islandSeed) * Math.PI * 2;
        // Cube-cage of 4 vertical posts and 3 horizontal bands
        for (const sx of [-1, 1] as const) {
          for (const sz of [-1, 1] as const) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 4), trapMat);
            post.position.set(sx * 0.22, 0.25, sz * 0.22);
            trap.add(post);
          }
        }
        for (let band = 0; band < 3; band++) {
          for (const ax of ['x', 'z'] as const) {
            const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 4), ropeMatN);
            bar.rotation.z = ax === 'x' ? 0 : Math.PI * 0.5;
            bar.rotation.x = ax === 'z' ? 0 : Math.PI * 0.5;
            bar.position.set(ax === 'x' ? 0 : 0.22, 0.08 + band * 0.16, ax === 'z' ? 0 : 0.22);
            // Two parallel sides per axis
            const bar2 = bar.clone();
            bar2.position.set(ax === 'x' ? 0 : -0.22, 0.08 + band * 0.16, ax === 'z' ? 0 : -0.22);
            trap.add(bar);
            trap.add(bar2);
          }
        }
        trap.castShadow = true;
        group.add(trap);
      }
    }

    // ── Stone idol cluster — three carved tiki-style faces ──
    if (!lowDetail && r > 50) {
      const idolMat = new THREE.MeshStandardMaterial({ color: 0x4a4338, roughness: 1, flatShading: true });
      const idolEyeMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 1, emissive: 0x6b1a06, emissiveIntensity: 0.3 });
      const idolAngle = island.profile.tertiaryHillAngle + (rng(islandSeed * 311) - 0.5) * 0.6;
      const cluster = new THREE.Group();
      const clusterCenter = surfacePoint(0.34 + rng(islandSeed * 313) * 0.18, idolAngle, 0);
      cluster.position.copy(clusterCenter);
      cluster.rotation.y = idolAngle + Math.PI;
      for (let i = 0; i < 3; i++) {
        const ix = (i - 1) * 1.4;
        const iz = (i - 1) * 0.3 + (rng(i * 317 + islandSeed) - 0.5) * 0.4;
        const groundY = getIslandSurfaceY(island, clusterCenter.x + island.position.x + ix, clusterCenter.z + island.position.z + iz) - clusterCenter.y;
        const idolH = 1.8 + rng(i * 319 + islandSeed) * 0.8;
        // Body block
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, idolH, 0.6), idolMat);
        body.position.set(ix, groundY + idolH * 0.5, iz);
        body.rotation.y = (rng(i * 321 + islandSeed) - 0.5) * 0.3;
        body.castShadow = true;
        body.receiveShadow = true;
        cluster.add(body);
        // Head
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.55), idolMat);
        head.position.set(ix, groundY + idolH + 0.27, iz);
        head.rotation.y = body.rotation.y;
        cluster.add(head);
        // Brow
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.16), idolMat);
        brow.position.set(ix, groundY + idolH + 0.35, iz + 0.22);
        brow.rotation.y = body.rotation.y;
        cluster.add(brow);
        // Eyes
        for (const sx of [-1, 1] as const) {
          const eye = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.05), idolEyeMat);
          eye.position.set(ix + sx * 0.14, groundY + idolH + 0.25, iz + 0.3);
          eye.rotation.y = body.rotation.y;
          cluster.add(eye);
        }
        // Wide mouth
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.04), idolEyeMat);
        mouth.position.set(ix, groundY + idolH + 0.05, iz + 0.3);
        cluster.add(mouth);
      }
      if (isSolidDecorPoint(clusterCenter, SURFACE_ABOVE_WATER, -0.2)) group.add(cluster);
    }

    // ── Hanging vines from the highest cliff & tallest trees ──
    if (!lowDetail && island.profile.heightProfile > 0.3) {
      const vineMat = new THREE.MeshStandardMaterial({ color: 0x355224, roughness: 0.95, side: THREE.DoubleSide });
      const vineCount = scaledCount(Math.round(r / 14), 3);
      for (let i = 0; i < vineCount; i++) {
        const va = rng(i * 941 + 23) * Math.PI * 2;
        const vd = 0.34 + rng(i * 947) * 0.32;
        const top = surfacePoint(vd, va, 0);
        if (!isSolidDecorPoint(top, SURFACE_ABOVE_WATER, -0.2)) continue;
        // Find ground a bit further out so the vine hangs over a slope drop
        const drop = 1.5 + rng(i * 953) * 3.0;
        const groundWX = top.x + island.position.x + Math.cos(va) * 1.6;
        const groundWZ = top.z + island.position.z + Math.sin(va) * 1.6;
        const groundY = getIslandSurfaceY(island, groundWX, groundWZ);
        const vineLen = Math.max(1.2, top.y - groundY + 0.2);
        if (vineLen > drop * 2) continue; // skip if vines would tunnel through ground
        // Vine ribbon
        const vine = new THREE.Mesh(new THREE.PlaneGeometry(0.16, vineLen), vineMat);
        vine.position.set(top.x + Math.cos(va) * 0.4, top.y - vineLen * 0.5 + 0.1, top.z + Math.sin(va) * 0.4);
        vine.rotation.y = va + Math.PI * 0.5;
        vine.rotation.z = (rng(i * 957) - 0.5) * 0.18;
        group.add(vine);
        // Leaves along the vine
        for (let l = 0; l < 4; l++) {
          const lt = (l + 0.5) / 4;
          const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.18), vineMat);
          leaf.position.set(
            top.x + Math.cos(va) * 0.4,
            top.y - vineLen * lt + 0.1,
            top.z + Math.sin(va) * 0.4 + (rng(l * 961 + i) - 0.5) * 0.1,
          );
          leaf.rotation.y = va + Math.PI * 0.5 + (rng(l * 963 + i) - 0.5) * 0.6;
          leaf.rotation.z = (rng(l * 967 + i) - 0.5) * 0.6;
          group.add(leaf);
        }
      }
    }

    // ── Buried-treasure stake markers (visual decoration, separate from gameplay chests) ──
    if (!lowDetail) {
      const stakeMat = new THREE.MeshStandardMaterial({ color: 0x3d2614, roughness: 1 });
      const stakeCount = 2 + Math.floor(rng(islandSeed * 971) * 3);
      for (let i = 0; i < stakeCount; i++) {
        const sa = rng(i * 977 + islandSeed) * Math.PI * 2;
        const sd = 0.22 + rng(i * 981 + islandSeed) * 0.42;
        const sp = surfacePoint(sd, sa, 0);
        if (!isSolidDecorPoint(sp, SURFACE_ABOVE_WATER, -0.2)) continue;
        const stake = new THREE.Group();
        stake.position.copy(sp);
        stake.rotation.y = rng(i * 983 + islandSeed) * Math.PI * 2;
        // Two crossed sticks forming an X
        for (let cross = 0; cross < 2; cross++) {
          const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.7, 4), stakeMat);
          stick.position.y = 0.35;
          stick.rotation.x = cross === 0 ? 0.5 : -0.5;
          stick.rotation.z = cross === 0 ? 0.5 : -0.5;
          stake.add(stick);
        }
        // Tiny red ribbon at the join
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.08), new THREE.MeshStandardMaterial({ color: 0xc02828, roughness: 0.9, side: THREE.DoubleSide }));
        ribbon.position.y = 0.55;
        stake.add(ribbon);
        group.add(stake);
      }
    }

    // ── Rope cliff ladder dangling from a high terrace down toward the beach ──
    if (!lowDetail && island.profile.heightProfile > 0.32 && rng(islandSeed * 991) > 0.25) {
      const ladderAngle = island.profile.ridgeAxis + Math.PI + (rng(islandSeed * 997) - 0.5) * 0.8;
      const top = surfacePoint(0.4, ladderAngle, 0);
      const bottom = surfacePoint(0.78, ladderAngle, 0);
      const dropY = top.y - bottom.y;
      if (dropY > 2.5 && isSolidDecorPoint(top, SURFACE_ABOVE_WATER, -0.2) && isSolidDecorPoint(bottom, SURFACE_ABOVE_WATER, -0.15)) {
        const dx = bottom.x - top.x;
        const dz = bottom.z - top.z;
        const horiz = Math.hypot(dx, dz);
        if (horiz > 0.5) {
          const len = Math.hypot(horiz, dropY);
          const yaw = Math.atan2(dx, dz);
          // Perpendicular horizontal direction (for ladder width)
          const perpX = Math.cos(yaw); // = dz/horiz
          const perpZ = -Math.sin(yaw); // = -dx/horiz
          // AUDIT P0 (floating-props): this was a dead-straight chord from a
          // terrace to the beach, so 82 of 114 rungs hung up to 3.1m in open air
          // over Crow's Perch while 27 more were buried in the hill. The ladder
          // now DRAPES: every rung and both rope polylines are sampled against
          // the shared terrain, so it lies on a sheer face like a hanging ladder
          // and follows a broken slope like a laid rope run.
          const rungCount = Math.max(8, Math.round(len / 0.5));
          /** Draped centreline sample: the terrain surface, never the chord. */
          const drapePoint = (t: number) => {
            const px = top.x + dx * t;
            const pz = top.z + dz * t;
            const gy = getIslandSurfaceY(island, px + island.position.x, pz + island.position.z);
            return { x: px, y: gy, z: pz };
          };
          const ropeMat = new THREE.LineBasicMaterial({ color: 0xc8b27a });
          // Two parallel rope polylines through the SAME sampled points, so the
          // rails follow every terrace and lip the rungs sit on.
          for (const sx of [-1, 1] as const) {
            const ox = perpX * sx * 0.22;
            const oz = perpZ * sx * 0.22;
            const ropePts: number[] = [];
            const ropeSteps = Math.max(6, Math.round(len / 1.0));
            for (let s = 0; s <= ropeSteps; s++) {
              const p = drapePoint(s / ropeSteps);
              ropePts.push(p.x + ox, p.y + 0.19, p.z + oz);
            }
            const ropeGeo = new THREE.BufferGeometry();
            ropeGeo.setAttribute('position', new THREE.Float32BufferAttribute(ropePts, 3));
            group.add(new THREE.Line(ropeGeo, ropeMat));
          }
          // Rungs: seated on the surface (<=0.25m clearance) and pitched to the
          // local grade so they lie flat on the rock rather than stepping.
          const rungMat2 = new THREE.MeshStandardMaterial({ color: 0x6e4c25, roughness: 0.95 });
          const rungGeo = new THREE.BoxGeometry(0.5, 0.045, 0.06);
          const rungs = new THREE.InstancedMesh(rungGeo, rungMat2, rungCount);
          rungs.name = 'ladder-rung';
          const rungObj = new THREE.Object3D();
          for (let r2 = 0; r2 < rungCount; r2++) {
            const t = (r2 + 0.5) / rungCount;
            const here = drapePoint(t);
            const ahead = drapePoint(Math.min(1, t + 0.5 / rungCount));
            const behind = drapePoint(Math.max(0, t - 0.5 / rungCount));
            const runDist = Math.max(0.05, Math.hypot(ahead.x - behind.x, ahead.z - behind.z));
            const pitch = Math.atan2(behind.y - ahead.y, runDist);
            rungObj.position.set(here.x, here.y + 0.14, here.z);
            rungObj.rotation.set(0, yaw, 0);
            rungObj.rotateX(-pitch);
            rungObj.scale.setScalar(1);
            rungObj.updateMatrix();
            rungs.setMatrixAt(r2, rungObj.matrix);
          }
          rungs.instanceMatrix.needsUpdate = true;
          group.add(rungs);
          // Anchor stakes at the top of the run
          const anchorStakeMat = new THREE.MeshStandardMaterial({ color: 0x3d2614, roughness: 1 });
          const head = drapePoint(0);
          for (const sx of [-1, 1] as const) {
            const ox = perpX * sx * 0.3;
            const oz = perpZ * sx * 0.3;
            const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.6, 5), anchorStakeMat);
            stake.position.set(head.x + ox, head.y + 0.1, head.z + oz);
            stake.castShadow = true;
            group.add(stake);
          }
        }
      }
    }

    // ── Secondary smaller wreck on bigger islands so they feel storied ──
    // (skipped when the server registry already placed a shipwreck landmark —
    // two wrecks on one beach reads as a bug, not a story)
    const hasRegistryWreck = (island.props ?? []).some((prop) => prop.type === 'shipwreck');
    if (!lowDetail && r > 64 && island.tavern === null && !hasRegistryWreck) {
      const wAngle = islandHeading + Math.PI * 1.45 + rng(islandSeed * 999) * 0.5;
      const wPos = surfacePoint(0.85 + rng(islandSeed * 1003) * 0.06, wAngle, 0);
      const wreck2Solid = isSolidDecorPoint(wPos, SURFACE_ABOVE_WATER, -0.15);
      const wreck2Glb = wreck2Solid
        ? this.buildPropInstance('shipwreck', wPos, -wAngle + Math.PI * 0.4, 0.5)
        : null;
      if (wreck2Glb) {
        wreck2Glb.rotation.z = (rng(islandSeed * 1009) - 0.5) * 0.24;
        group.add(wreck2Glb);
      } else if (wreck2Solid) {
      const wreck2 = new THREE.Group();
      wreck2.position.copy(wPos);
      wreck2.rotation.y = -wAngle + Math.PI * 0.4;
      wreck2.rotation.z = (rng(islandSeed * 1009) - 0.5) * 0.6;
      // Just a half-buried hull section + scattered planks
      const sectionMat = new THREE.MeshStandardMaterial({ color: 0x4b2f16, roughness: 1 });
      const section = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.2), sectionMat);
      section.position.y = 0.22;
      section.rotation.z = -0.18;
      section.castShadow = true;
      wreck2.add(section);
      for (let p = 0; p < 5; p++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 1.0 + rng(p * 1019 + islandSeed) * 0.6), sectionMat);
        const lx = (rng(p * 1021 + islandSeed) - 0.5) * 2.6;
        const lz = (rng(p * 1023 + islandSeed) - 0.5) * 2.4;
        const lY = getIslandSurfaceY(island, wPos.x + island.position.x + lx, wPos.z + island.position.z + lz) - wPos.y;
        plank.position.set(lx, lY + 0.05, lz);
        plank.rotation.set(0.04, rng(p * 1027 + islandSeed) * Math.PI * 2, (rng(p * 1031 + islandSeed) - 0.5) * 0.3);
        wreck2.add(plank);
      }
      // Loose rib timbers stuck in the sand
      for (let r3 = 0; r3 < 3; r3++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9 + rng(r3 * 1037 + islandSeed) * 0.5, 0.12), sectionMat);
        rib.position.set(0.6 + r3 * 0.4, 0.42, 0.6);
        rib.rotation.z = 0.45 + rng(r3 * 1041) * 0.2;
        wreck2.add(rib);
      }
      group.add(wreck2);
      }
    }

    // ── Trails — packed-dirt paths between dock, tavern, upgrade stations, hoarder, ruins ──
    {
      type WP = { x: number; z: number; kind: 'dock' | 'tavern' | 'npc' | 'upgrade' };
      const waypoints: WP[] = [];
      if (island.dock) waypoints.push({ x: island.dock.respawnPoint.x, z: island.dock.respawnPoint.z, kind: 'dock' });
      if (island.tavern) {
        const t = island.tavern;
        const cosR = Math.cos(t.rotation);
        const sinR = Math.sin(t.rotation);
        waypoints.push({
          x: t.position.x + sinR * (t.depth * 0.5 + 1.6),
          z: t.position.z + cosR * (t.depth * 0.5 + 1.6),
          kind: 'tavern',
        });
      }
      for (const station of island.upgradeStations) waypoints.push({ x: station.position.x, z: station.position.z, kind: 'upgrade' });
      for (const npc of island.npcs) {
        if (npc.role === 'bartender') continue; // bartender is inside the tavern
        waypoints.push({ x: npc.position.x, z: npc.position.z, kind: 'npc' });
      }

      if (waypoints.length >= 2) {
        // Greedy nearest-neighbour ordering anchored at the dock if present.
        const ordered: WP[] = [];
        const remaining = [...waypoints];
        const startIndex = Math.max(0, remaining.findIndex((w) => w.kind === 'dock'));
        ordered.push(remaining.splice(startIndex, 1)[0]);
        while (remaining.length) {
          const last = ordered[ordered.length - 1];
          let bestIndex = 0;
          let bestDist = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const dx = remaining[i].x - last.x;
            const dz = remaining[i].z - last.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestIndex = i; }
          }
          ordered.push(remaining.splice(bestIndex, 1)[0]);
        }

        const trailMat = new THREE.MeshStandardMaterial({ color: 0xb09169, roughness: 1 });
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6c5e4a, roughness: 1 });
        const trailWidth = 1.6;
        const stepLen = 1.6;
        // Every tile and kerb stone used to be its own Mesh — ~500 draw calls
        // scene-wide for the path network alone. Collect transforms and emit two
        // InstancedMeshes per island instead (unit box + shared decor boulder).
        const tileXf: THREE.Matrix4[] = [];
        const kerbXf: THREE.Matrix4[] = [];
        const trM = new THREE.Matrix4();
        const trP = new THREE.Vector3();
        const trQ = new THREE.Quaternion();
        const trE = new THREE.Euler();
        const trS = new THREE.Vector3();
        const trObj = new THREE.Object3D();

        for (let w = 0; w < ordered.length - 1; w++) {
          const a = ordered[w];
          const b = ordered[w + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 1.5 || dist > island.radius * 1.6) continue;
          const steps = Math.max(2, Math.floor(dist / stepLen));
          const yaw = Math.atan2(dx, dz);
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            // Slight serpentine to feel hand-walked, not surveyed.
            const wiggleAmp = Math.min(1.2, dist * 0.04);
            const offset = Math.sin(t * Math.PI * 2 + w * 1.7) * wiggleAmp * (1 - Math.abs(t - 0.5) * 1.4);
            const px = a.x + dx * t + Math.cos(yaw) * offset;
            const pz = a.z + dz * t - Math.sin(yaw) * offset;
            const py = getIslandSurfaceY(island, px, pz);
            if (py < 5.4) continue;
            // AUDIT P1/P2: each tile was a 0.08m slab dropped flat at ONE centre
            // sample, so on any grade its downhill edge cantilevered into open
            // air and the run read as a jagged staircase of floating pavers.
            // Now: sampled at the four corners, pitched into the local slope,
            // thickened into a stone kerb and sunk so the downhill edge is
            // swallowed by the ground (the thickness IS the downhill skirt).
            const halfW = (trailWidth + (rng(s * 17 + w * 13) - 0.5) * 0.3) * 0.5;
            const halfL = (stepLen + 0.05) * 0.5;
            const tYaw = yaw + (rng(s * 19 + w * 23) - 0.5) * 0.06;
            const fwdX = Math.sin(tYaw), fwdZ = Math.cos(tYaw);
            const sideX = Math.cos(tYaw), sideZ = -Math.sin(tYaw);
            const cornerY = (fs: number, ss: number) => getIslandSurfaceY(
              island,
              px + fwdX * halfL * fs + sideX * halfW * ss,
              pz + fwdZ * halfL * fs + sideZ * halfW * ss,
            );
            const yFf = cornerY(1, 0), yBb = cornerY(-1, 0);
            const yLl = cornerY(0, 1), yRr = cornerY(0, -1);
            const minCorner = Math.min(py, yFf, yBb, yLl, yRr);
            const tileThick = 0.26;
            // Slope basis from the corner samples: pitch along the path, roll across it.
            const pitch = Math.atan2(yBb - yFf, halfL * 2);
            const roll = Math.atan2(yLl - yRr, halfW * 2);
            trObj.position.set(px - island.position.x, minCorner + 0.02, pz - island.position.z);
            trObj.rotation.set(0, tYaw, 0);
            trObj.rotateX(pitch);
            trObj.rotateZ(roll);
            trObj.scale.set(halfW * 2, tileThick, halfL * 2);
            trObj.updateMatrix();
            tileXf.push(trObj.matrix.clone());
            // Occasional border stones
            if (!lowDetail && rng(s * 29 + w * 31) > 0.78) {
              const side = rng(s * 33 + w * 41) > 0.5 ? 1 : -1;
              const stx = px + Math.cos(yaw) * side * (trailWidth * 0.55 + 0.2);
              const stz = pz - Math.sin(yaw) * side * (trailWidth * 0.55 + 0.2);
              const sty = getIslandSurfaceY(island, stx, stz);
              trP.set(stx - island.position.x, sty + 0.16, stz - island.position.z);
              trE.set(rng(s * 51) * Math.PI, rng(s * 57) * Math.PI, rng(s * 61) * Math.PI);
              trQ.setFromEuler(trE);
              trS.setScalar(0.18 + rng(s * 47 + w * 53) * 0.18);
              kerbXf.push(trM.clone().compose(trP, trQ, trS));
            }
          }
        }
        if (tileXf.length) {
          const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), trailMat, tileXf.length);
          tiles.name = 'trail-tile';
          tileXf.forEach((m, k) => tiles.setMatrixAt(k, m));
          tiles.instanceMatrix.needsUpdate = true;
          tiles.receiveShadow = true;
          group.add(tiles);
        }
        if (kerbXf.length) {
          const kerbs = new THREE.InstancedMesh(boulderGeo, stoneMat, kerbXf.length);
          kerbXf.forEach((m, k) => kerbs.setMatrixAt(k, m));
          kerbs.instanceMatrix.needsUpdate = true;
          kerbs.castShadow = true;
          group.add(kerbs);
        }

        // Trailhead post at the dock side
        if (island.dock) {
          const head = new THREE.Group();
          const hx = island.dock.respawnPoint.x;
          const hz = island.dock.respawnPoint.z;
          const hy = getIslandSurfaceY(island, hx, hz);
          head.position.set(hx - island.position.x, hy, hz - island.position.z);
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.5, 0.18), new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 }));
          post.position.y = 0.75;
          post.castShadow = true;
          head.add(post);
          const sign = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.32, 0.06), new THREE.MeshStandardMaterial({ color: 0x6e4c25, roughness: 0.95 }));
          sign.position.set(0.42, 1.25, 0);
          head.add(sign);
          group.add(head);
        }
      }
    }

    // ── Reef ring — sharp dark rocks just offshore ──
    {
      const reefMatDark = new THREE.MeshStandardMaterial({ color: 0x5b5348, roughness: 1 });
      const reefMatWet = new THREE.MeshStandardMaterial({ color: 0x6d6455, roughness: 0.9 });
      const reefCount = scaledCount(Math.round(r / 8), 5);
      const reefGeoSharp = new THREE.ConeGeometry(0.7, 1.2, 5);
      const reefGeoChunk = new THREE.DodecahedronGeometry(0.6, 0);
      for (let i = 0; i < reefCount; i++) {
        const angle = rng(i * 401 + 91) * Math.PI * 2;
        const distRatio = 1.06 + rng(i * 409 + 97) * 0.22;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const fx = cosA * island.radius * distRatio * island.profile.footprintX;
        const fz = sinA * island.radius * distRatio * island.profile.footprintZ;
        const seaY = 0.05;
        const sharp = rng(i * 419) > 0.5;
        const reef = new THREE.Mesh(
          sharp ? reefGeoSharp : reefGeoChunk,
          rng(i * 421) > 0.4 ? reefMatDark : reefMatWet,
        );
        const stickOut = (rng(i * 431) - 0.3) * 1.6; // some submerged, some breaking
        const scale = 0.7 + rng(i * 433) * 1.4;
        reef.scale.set(scale * (0.7 + rng(i * 437) * 0.6), scale * (0.6 + rng(i * 441) * 1.2), scale * (0.7 + rng(i * 443) * 0.6));
        // AUDIT P2: these were pinned to a fixed sea offset regardless of what
        // was (or wasn't) under them, so rocks over a sub-sea shelf hung in mid
        // air above the water with their foam ring painted on the sea below.
        // Seat on the seabed where it's shallow enough to reach, and always
        // keep the base at least ~0.2m under the waterline so nothing floats.
        const reefHalfH = 0.6 * reef.scale.y;   // both source geos are 1.2 tall
        const bedY = getIslandSurfaceY(island, fx + island.position.x, fz + island.position.z);
        const seated = bedY > -0.6 ? bedY + reefHalfH * 0.55 : seaY + stickOut;
        reef.position.set(fx, Math.min(seated, reefHalfH - 0.2), fz);
        reef.rotation.set(rng(i * 447) * 0.6, rng(i * 449) * Math.PI * 2, (rng(i * 451) - 0.5) * 0.6);
        reef.castShadow = false;
        reef.receiveShadow = true;
        group.add(reef);

        // Add a small splash collar of foam (a flat ring sliver) for ones poking above water
        if (reef.position.y + reefHalfH > 0.12 && !lowDetail) {
          const foam = new THREE.Mesh(
            new THREE.RingGeometry(scale * 0.55, scale * 0.95, 12),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
          );
          foam.rotation.x = -Math.PI * 0.5;
          foam.position.set(fx, seaY + 0.01, fz);
          group.add(foam);
        }
      }
    }

    // ── Sharp rock spires — jagged peaks for mountain/rocky islands ──
    if (island.profile.terrainStyle === 'mountain' || island.profile.terrainStyle === 'rocky') {
      const spireMat = new THREE.MeshStandardMaterial({ color: 0x6a5f52, roughness: 1, flatShading: true });
      const spireCount = scaledCount(island.profile.terrainStyle === 'mountain' ? 4 : 3, 2);
      for (let i = 0; i < spireCount; i++) {
        const angle = island.profile.ridgeAxis + (i / spireCount) * Math.PI + rng(i * 503 + 13) * 0.6;
        const distRatio = 0.32 + rng(i * 509 + 17) * 0.4;
        const surface = surfacePoint(distRatio, angle);
        if (!isSolidDecorPoint(surface, SURFACE_ABOVE_WATER, -0.2)) continue;
        const spireH = 4 + rng(i * 521) * (island.profile.terrainStyle === 'mountain' ? 9 : 5);
        const spireR = 0.7 + rng(i * 523) * 1.6;
        // Tilt is bounded so cos(tilt) ≈ 1 and the base never lifts visibly.
        const tiltX = (rng(i * 533) - 0.5) * 0.12;
        const tiltZ = (rng(i * 541) - 0.5) * 0.14;
        const spire = new THREE.Mesh(
          new THREE.ConeGeometry(spireR, spireH, 4 + Math.floor(rng(i * 529) * 2), 1),
          spireMat,
        );
        // Sink a portion of the base into the ground so even with a small tilt, no
        // wedge of rock is visibly hovering. Cones are centered, so y = base + h/2.
        const burial = 0.35 + rng(i * 545) * 0.4;
        spire.position.set(surface.x, surface.y + spireH * 0.5 - burial, surface.z);
        spire.rotation.set(tiltX, rng(i * 537) * Math.PI * 2, tiltZ);
        spire.castShadow = true;
        spire.receiveShadow = true;
        group.add(spire);

        // Anchoring rubble pile around the spire base so the transition reads as
        // weathered rather than placed.
        const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x3e342a, roughness: 1 });
        for (let s = 0; s < 4; s++) {
          const sa = (s / 4) * Math.PI * 2 + rng(i * 543 + s) * 0.5;
          const rOff = spireR * (0.85 + rng(i * 549 + s) * 0.35);
          const rx = surface.x + Math.cos(sa) * rOff;
          const rz = surface.z + Math.sin(sa) * rOff;
          const ry = getIslandSurfaceY(island, rx + island.position.x, rz + island.position.z);
          const rock = new THREE.Mesh(boulderGeo, rubbleMat);
          rock.scale.setScalar(0.35 + rng(i * 551 + s) * 0.32);
          rock.position.set(rx, ry + 0.18, rz);
          rock.rotation.set(rng(i * 553 + s) * Math.PI, rng(i * 557 + s) * Math.PI, rng(i * 561 + s) * Math.PI);
          rock.castShadow = true;
          group.add(rock);
        }

        // Sometimes a smaller adjoining spike, also grounded properly
        if (rng(i * 547) > 0.45) {
          const sub = new THREE.Mesh(
            new THREE.ConeGeometry(spireR * 0.55, spireH * 0.6, 4, 1),
            spireMat,
          );
          const offX = (rng(i * 549) - 0.5) * spireR * 2.5;
          const offZ = (rng(i * 551) - 0.5) * spireR * 2.5;
          const subSurfY = getIslandSurfaceY(island, surface.x + offX + island.position.x, surface.z + offZ + island.position.z);
          const subTiltX = (rng(i * 553) - 0.5) * 0.18;
          const subTiltZ = (rng(i * 561) - 0.5) * 0.22;
          const subBurial = 0.25;
          sub.position.set(surface.x + offX, subSurfY + spireH * 0.6 * 0.5 - subBurial, surface.z + offZ);
          sub.rotation.set(subTiltX, rng(i * 557) * Math.PI * 2, subTiltZ);
          sub.castShadow = true;
          group.add(sub);
        }
      }
    }

    // ── Bridges — rope-and-plank, rendered from the SERVER's replicated
    // registry: endpoints are true terrain local-maxima found at generation,
    // and the deck players walk on is the shared getBridgeDeckY math, so the
    // bridge is genuinely solid and both ends sit flush on their peaks (the
    // old client-only version guessed hill centers and connected to nothing).
    for (const islandBridge of island.bridges ?? []) {
      const a = { lx: islandBridge.ax - island.position.x, lz: islandBridge.az - island.position.z, y: islandBridge.ay };
      const b = { lx: islandBridge.bx - island.position.x, lz: islandBridge.bz - island.position.z, y: islandBridge.by };
      const dx = b.lx - a.lx;
      const dz = b.lz - a.lz;
      const span = Math.hypot(dx, dz);
      {
        const bridge = new THREE.Group();
        const midX = (a.lx + b.lx) * 0.5;
        const midZ = (a.lz + b.lz) * 0.5;
        const yaw = Math.atan2(dx, dz);
        // Anchor bridge at midpoint, midpoint y = average of the two peaks (so each end rests at its peak)
        const midY = (a.y + b.y) * 0.5;
        bridge.position.set(midX, midY, midZ);
        bridge.rotation.y = yaw;
        // Tilt bridge so each end matches its own peak height (rotate around X axis;
        // local +Z corresponds to peak b after rotation.y, so we need negative tilt).
        const tilt = Math.atan2(b.y - a.y, span);
        bridge.rotation.x = -tilt;

        const plankMat2 = new THREE.MeshStandardMaterial({ color: 0x6b4623, roughness: 0.95 });
        const ropeMat2 = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
        const postMat2 = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1 });

        // End posts: their bases sit at z = ±span/2 in local space (which maps to each peak after tilt)
        for (const end of [-1, 1] as const) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.6, 0.32), postMat2);
          post.position.set(0, 0.8, end * span * 0.5);
          post.castShadow = true;
          bridge.add(post);
          const cap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), postMat2);
          cap.position.set(0, 1.7, end * span * 0.5);
          bridge.add(cap);
          // Anchoring cairn (so the post visually grounds into the rock)
          for (let s = 0; s < 4; s++) {
            const stone = new THREE.Mesh(boulderGeo, boulderMat);
            const ang = (s / 4) * Math.PI * 2;
            stone.position.set(Math.cos(ang) * 0.5, 0.18, end * span * 0.5 + Math.sin(ang) * 0.5);
            stone.scale.setScalar(0.22 + rng(s * 851 + (end > 0 ? 1 : 2)) * 0.18);
            stone.rotation.set(rng(s * 853) * Math.PI, rng(s * 857) * Math.PI, rng(s * 859) * Math.PI);
            bridge.add(stone);
          }
        }

        // Sagging plank deck — sag is measured from the y=0 reference plane (bridge midline)
        const plankCount = Math.max(8, Math.floor(span / 0.55));
        for (let i = 0; i < plankCount; i++) {
          const t = (i + 0.5) / plankCount;
          const z = (t - 0.5) * span;
          const sag = -Math.sin(t * Math.PI) * Math.min(0.9, span * 0.04);
          const plank = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.42), plankMat2);
          plank.position.set((rng(i * 601) - 0.5) * 0.05, sag, z);
          plank.rotation.z = (rng(i * 607) - 0.5) * 0.04;
          plank.rotation.x = (rng(i * 611) - 0.5) * 0.03;
          plank.castShadow = true;
          plank.receiveShadow = true;
          bridge.add(plank);
        }

        // Two rope rails
        const ropeSegments = 24;
        for (const side of [-1, 1] as const) {
          const railPositions: number[] = [];
          for (let i = 0; i <= ropeSegments; i++) {
            const t = i / ropeSegments;
            const z = (t - 0.5) * span;
            const sag = -Math.sin(t * Math.PI) * Math.min(0.6, span * 0.03);
            railPositions.push(side * 0.7, 0.78 + sag, z);
          }
          const railGeo = new THREE.BufferGeometry();
          railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railPositions, 3));
          const rail = new THREE.Line(railGeo, new THREE.LineBasicMaterial({ color: 0xc8b27a }));
          bridge.add(rail);

          // Lower handhold rope
          const lowerPos: number[] = [];
          for (let i = 0; i <= ropeSegments; i++) {
            const t = i / ropeSegments;
            const z = (t - 0.5) * span;
            const sag = -Math.sin(t * Math.PI) * Math.min(0.9, span * 0.04);
            lowerPos.push(side * 0.6, 0.04 + sag, z);
          }
          const lowerGeo = new THREE.BufferGeometry();
          lowerGeo.setAttribute('position', new THREE.Float32BufferAttribute(lowerPos, 3));
          const lower = new THREE.Line(lowerGeo, new THREE.LineBasicMaterial({ color: 0xc8b27a }));
          bridge.add(lower);

          // Vertical lashings
          const verticalCount = Math.max(6, Math.floor(span / 1.2));
          for (let v = 0; v < verticalCount; v++) {
            const tv = (v + 0.5) / verticalCount;
            const zv = (tv - 0.5) * span;
            const sagTop = -Math.sin(tv * Math.PI) * Math.min(0.6, span * 0.03);
            const sagBot = -Math.sin(tv * Math.PI) * Math.min(0.9, span * 0.04);
            const lash = new THREE.Mesh(
              new THREE.CylinderGeometry(0.02, 0.02, Math.max(0.5, 0.78 - 0.04 + sagTop - sagBot), 4),
              ropeMat2,
            );
            lash.position.set(side * 0.65, (0.78 + sagTop + 0.04 + sagBot) * 0.5, zv);
            bridge.add(lash);
          }
        }

        group.add(bridge);
      }
    }

    // ── Peak mist — tall summits wear a slow ring of cloud (SoT reference) ──
    {
      const profileMist = island.profile;
      const peakLocalX = Math.cos(profileMist.primaryHillAngle) * profileMist.primaryHillOffset * profileMist.footprintX;
      const peakLocalZ = Math.sin(profileMist.primaryHillAngle) * profileMist.primaryHillOffset * profileMist.footprintZ;
      const peakY = getIslandSurfaceY(island, island.position.x + peakLocalX, island.position.z + peakLocalZ);
      if (!lowDetail && peakY > 30) {
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(255,255,255,0.55)');
        grad.addColorStop(0.6, 'rgba(255,255,255,0.22)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        const mistTex = new THREE.CanvasTexture(canvas);
        for (let m = 0; m < 6; m++) {
          const mistSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: mistTex,
            transparent: true,
            opacity: 0.4 + rng(m * 977) * 0.2,
            depthWrite: false,
          }));
          const ma = (m / 6) * Math.PI * 2 + rng(m * 983) * 0.8;
          const mr = 7 + rng(m * 991) * 9;
          mistSprite.position.set(
            peakLocalX + Math.cos(ma) * mr,
            peakY - 4 - rng(m * 997) * 5,
            peakLocalZ + Math.sin(ma) * mr,
          );
          const ms = 9 + rng(m * 1009) * 8;
          mistSprite.scale.set(ms, ms * 0.55, 1);
          group.add(mistSprite);
        }
      }
    }

    if (!lowDetail && r > 48) {
      const ruin = new THREE.Group();
      const ruinAngle = island.profile.primaryHillAngle + rng(islandSeed * 17) * 0.8;
      const ruinPos = surfacePoint(0.18 + rng(islandSeed * 23) * 0.18, ruinAngle, 0.02);
      ruin.position.copy(ruinPos);
      ruin.rotation.y = rng(islandSeed * 31) * Math.PI * 2;

      for (let pillar = 0; pillar < 3; pillar++) {
        const angle = (pillar / 3) * Math.PI * 2;
        const height = 1.0 + rng(pillar * 347) * 1.2;
        const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, height, 7), shrineMat);
        stone.position.set(Math.cos(angle) * 0.9, height * 0.5, Math.sin(angle) * 0.7);
        stone.rotation.z = (rng(pillar * 349) - 0.5) * 0.18;
        stone.castShadow = true;
        ruin.add(stone);
      }

      const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.24, 0.34), shrineMat);
      lintel.position.set(0, 1.62, -0.12);
      lintel.rotation.z = (rng(islandSeed * 37) - 0.5) * 0.12;
      lintel.castShadow = true;
      ruin.add(lintel);

      const bowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.34, 0.16, 8),
        new THREE.MeshStandardMaterial({ color: 0x27231d, roughness: 0.9, emissive: 0x3a1e08, emissiveIntensity: 0.28 }),
      );
      bowl.position.set(0.18, 0.12, 0.34);
      ruin.add(bowl);

      if (isSolidDecorPoint(ruinPos, SURFACE_ABOVE_WATER, -0.2)) group.add(ruin);
    }

    if (!lowDetail) {
      const terraceMat = new THREE.MeshStandardMaterial({ color: 0xa48d62, roughness: 0.98 });
      const terraceCount = r > 58 ? 3 : 2;
      for (let i = 0; i < terraceCount; i++) {
        const angle = island.profile.ridgeAxis + (i - 1) * 0.46 + (rng(i * 1103 + islandSeed) - 0.5) * 0.18;
        const pos = surfacePoint(0.34 + i * 0.08 + rng(i * 1109 + islandSeed) * 0.06, angle, 0.035);
        if (pos.y < 1.4 || !isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) continue;
        const ledge = new THREE.Mesh(
          new THREE.BoxGeometry(3.8 + rng(i * 1117 + islandSeed) * 2.2, 0.12, 1.0 + rng(i * 1123 + islandSeed) * 0.65),
          terraceMat,
        );
        ledge.position.copy(pos);
        ledge.rotation.y = -angle + Math.PI * 0.5;
        ledge.rotation.z = (rng(i * 1129 + islandSeed) - 0.5) * 0.08;
        ledge.castShadow = true;
        ledge.receiveShadow = true;
        group.add(ledge);
      }

      const crabMat = new THREE.MeshStandardMaterial({ color: 0xb53a2b, roughness: 0.86 });
      const shellMat = new THREE.MeshStandardMaterial({ color: 0xeee0c2, roughness: 0.94 });
      const animalCount = 0; // replicated wildlife is rendered separately so every animal can move and be killed
      for (let i = 0; i < animalCount; i++) {
        const angle = islandHeading + Math.PI * 0.72 + rng(i * 1201 + islandSeed) * Math.PI * 1.1;
        const crab = new THREE.Group();
        crab.position.copy(surfacePoint(0.78 + rng(i * 1207 + islandSeed) * 0.15, angle, 0.08));
        crab.rotation.y = rng(i * 1213 + islandSeed) * Math.PI * 2;
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), crabMat);
        body.scale.set(1.35, 0.55, 0.9);
        crab.add(body);
        for (const side of [-1, 1]) {
          const claw = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 4), crabMat);
          claw.position.set(0.18, 0.02, side * 0.18);
          claw.scale.set(1.25, 0.7, 1);
          crab.add(claw);
          for (let leg = 0; leg < 3; leg++) {
            const limb = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.018, 0.025), crabMat);
            limb.position.set(-0.05 - leg * 0.055, -0.03, side * (0.12 + leg * 0.055));
            limb.rotation.y = side * (0.55 + leg * 0.18);
            crab.add(limb);
          }
        }
        group.add(crab);
      }

      const gullBodyMat = new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.78 });
      const gullWingMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc4, roughness: 0.82, side: THREE.DoubleSide });
      const gullCount = 0; // replicated wildlife is rendered separately so gulls are not static props
      for (let i = 0; i < gullCount; i++) {
        const angle = island.profile.primaryHillAngle + rng(i * 1301 + islandSeed) * Math.PI * 2;
        const gull = new THREE.Group();
        gull.position.copy(surfacePoint(0.48 + rng(i * 1307 + islandSeed) * 0.34, angle, 0.22));
        gull.rotation.y = rng(i * 1313 + islandSeed) * Math.PI * 2;
        const body = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 5), gullBodyMat);
        body.scale.set(1.25, 0.75, 0.85);
        gull.add(body);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), gullBodyMat);
        head.position.set(0.14, 0.08, 0);
        gull.add(head);
        for (const side of [-1, 1]) {
          const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.12), gullWingMat);
          wing.position.set(0, 0.02, side * 0.13);
          wing.rotation.set(0.18, 0, side * 0.32);
          gull.add(wing);
        }
        group.add(gull);

        if (rng(i * 1321 + islandSeed) > 0.45) {
          const shell = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), shellMat);
          shell.scale.set(1.3, 0.35, 0.8);
          shell.position.copy(surfacePoint(0.86 + rng(i * 1327 + islandSeed) * 0.08, angle + 0.35, 0.05));
          shell.rotation.y = rng(i * 1331 + islandSeed) * Math.PI * 2;
          group.add(shell);
        }
      }
    }

    {
      const detailRoot = new THREE.Group();
      detailRoot.name = 'island-detail-root';
      while (group.children.length > 0) {
        detailRoot.add(group.children[0]);
      }

      // ── Micro-decor tier ──────────────────────────────────────────────
      // Islands used to render EVERY bespoke decor mesh (shells, rubble,
      // stalactites, tidepools, camp clutter…) out to the full detail radius —
      // ~370 visible meshes per island, ~3.7k scene-wide, most far too small
      // to read past 250m. Reparent small pieces into a near-only tier: no
      // shadow casting, hidden beyond microRadius in updateEnvironmentLod.
      const microRoot = new THREE.Group();
      microRoot.name = 'island-micro-root';
      {
        const keepNames = new Set(['island-terrain', 'island-shore-skirt']);
        const bbox = new THREE.Box3();
        const size = new THREE.Vector3();
        const micro: THREE.Object3D[] = [];
        for (const child of detailRoot.children) {
          if (keepNames.has(child.name)) continue;
          if (child instanceof THREE.InstancedMesh) continue; // prop batches stay
          bbox.setFromObject(child);
          if (bbox.isEmpty()) continue;
          bbox.getSize(size);
          if (Math.max(size.x, size.y, size.z) < 3.6) micro.push(child);
        }
        for (const child of micro) {
          microRoot.add(child);
          child.traverse((obj) => {
            if (obj instanceof THREE.Mesh) obj.castShadow = false;
          });
        }
        detailRoot.add(microRoot);
      }

      const proxyRoot = new THREE.Group();
      proxyRoot.name = 'island-proxy-root';
      proxyRoot.visible = false;
      proxyRoot.add(buildProxyTerrainMesh(ctx, terrain));

      if (lowDetail) {
        detailRoot.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = false;
            obj.receiveShadow = false;
          }
        });
      }
      proxyRoot.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = false;
          obj.receiveShadow = true;
        }
      });

      group.add(detailRoot);
      group.add(proxyRoot);
      group.userData.detailRoot = detailRoot;
      group.userData.proxyRoot = proxyRoot;
      group.userData.microRoot = microRoot;
      // Resolve the distance-gated foliage layers ONCE. updateEnvironmentLod runs
      // every frame for every island; looking these up by name there meant four
      // recursive scene-graph walks per island per frame.
      group.userData.lodLayers = (['island-grass', 'island-ferns', 'island-shells'] as const)
        .map((name) => ({
          node: detailRoot.getObjectByName(name) ?? null,
          // Shells are ankle-height flecks — they stop reading first.
          radius: name === 'island-shells' ? 200 : 300,
        }))
        .filter((layer): layer is { node: THREE.Object3D; radius: number } => layer.node !== null);
    }

    this.ctx.environment.add(group);
    this.ctx.islandMeshes.set(island.id, group);

    for (const chest of island.chests) {
      const chestGroup = new THREE.Group();
      chestGroup.position.set(chest.position.x, chest.position.y, chest.position.z);

      const surfaceY = getIslandSurfaceY(island, chest.position.x, chest.position.z);

      let chestMesh: THREE.Object3D;
      let lid: THREE.Object3D;
      const chestGlb = this.buildPropInstance(
        'chest_closed',
        new THREE.Vector3(0, -0.42, 0),
        (chest.position.x * 7.13 + chest.position.z * 3.71) % (Math.PI * 2),
        1.15,
      );
      if (chestGlb) {
        chestGroup.add(chestGlb);
        chestMesh = chestGlb;
        lid = new THREE.Group(); // GLB includes the lid; keep the record shape for syncChests
        chestGroup.add(lid);
      } else {
        const chestBox = new THREE.Mesh(
          new THREE.BoxGeometry(1.1, 0.7, 0.75),
          new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.95 }),
        );
        chestBox.castShadow = true;
        chestGroup.add(chestBox);
        chestMesh = chestBox;

        const lidMesh = new THREE.Mesh(
          new THREE.BoxGeometry(1.08, 0.2, 0.75),
          new THREE.MeshStandardMaterial({ color: 0x8b5e2f, roughness: 0.9 }),
        );
        lidMesh.position.y = 0.42;
        chestGroup.add(lidMesh);
        lid = lidMesh;
      }

      const glow = new THREE.PointLight(0xffc75a, 1.2, 12);
      glow.position.set(0, 1.2, 0);
      glow.visible = false; // gated to ~55m by updateEnvironmentLod (light budget)
      chestGroup.userData.decorLight = lowDetail ? null : glow;
      chestGroup.add(glow);

      let mound: THREE.Mesh | null = null;
      if (chest.buried) {
        mound = new THREE.Mesh(
          new THREE.ConeGeometry(1.05, 0.52, 8),
          new THREE.MeshStandardMaterial({ color: 0x4a3c26, roughness: 1 }),
        );
        mound.position.set(0, surfaceY - chest.position.y + 0.1, 0);
        mound.castShadow = true;
        chestGroup.add(mound);
        chestMesh.visible = false;
        lid.visible = false;
        glow.intensity = 0.4;
        glow.position.set(0, surfaceY - chest.position.y + 0.85, 0);
      }

      this.ctx.environment.add(chestGroup);
      this.ctx.chestMeshes.set(chest.id, { root: chestGroup, glow, chestMesh, lid, mound });
    }

    for (const barrel of island.barrels) {
      const barrelRoot = new THREE.Group();
      barrelRoot.position.set(barrel.position.x, barrel.position.y, barrel.position.z);
      const barrelGlb = this.buildPropInstance(
        'barrel',
        new THREE.Vector3(0, 0, 0),
        (barrel.position.x * 5.31 + barrel.position.z * 2.17) % (Math.PI * 2),
        0.88,
      );
      if (barrelGlb) {
        barrelRoot.add(barrelGlb);
      } else {
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3010, roughness: 0.95 });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.72, 10), woodMat);
        body.position.y = 0.36;
        body.castShadow = true;
        barrelRoot.add(body);
        const lidB = new THREE.Mesh(
          new THREE.CylinderGeometry(0.36, 0.36, 0.06, 10),
          new THREE.MeshStandardMaterial({ color: 0x2a4a6a, roughness: 0.85 }),
        );
        lidB.position.y = 0.78;
        barrelRoot.add(lidB);
      }
      this.ctx.environment.add(barrelRoot);
      this.ctx.barrelMeshes.set(barrel.id, barrelRoot);
    }

    for (const station of island.upgradeStations) {
      const meta = this.ctx.getUpgradePresentation(station.type);
      const stationGroup = new THREE.Group();
      stationGroup.position.set(station.position.x, station.position.y - 0.24, station.position.z);

      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6d6558, roughness: 1 });
      const sootMat = new THREE.MeshStandardMaterial({ color: 0x2b2723, roughness: 1 });

      const groundPad = new THREE.Mesh(
        new THREE.CylinderGeometry(1.08, 1.24, 0.22, 9),
        stoneMat,
      );
      groundPad.position.y = -0.08;
      groundPad.castShadow = true;
      groundPad.receiveShadow = true;
      stationGroup.add(groundPad);

      const firePit = new THREE.Mesh(
        new THREE.CylinderGeometry(0.48, 0.56, 0.14, 8),
        sootMat,
      );
      firePit.position.y = 0.06;
      firePit.castShadow = true;
      firePit.receiveShadow = true;
      stationGroup.add(firePit);

      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.72, 0.94, 0.28, 7),
        new THREE.MeshStandardMaterial({ color: 0x4b3b28, roughness: 0.96 }),
      );
      base.position.y = 0.14;
      base.castShadow = true;
      base.receiveShadow = true;
      stationGroup.add(base);

      const anvilBase = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 0.34, 0.34),
        new THREE.MeshStandardMaterial({ color: 0x2f333d, roughness: 0.62, metalness: 0.58 }),
      );
      anvilBase.position.y = 0.46;
      anvilBase.castShadow = true;
      stationGroup.add(anvilBase);

      const anvilTop = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 0.12, 0.28),
        new THREE.MeshStandardMaterial({ color: 0x4b5262, roughness: 0.42, metalness: 0.75 }),
      );
      anvilTop.position.set(0.08, 0.68, 0);
      anvilTop.castShadow = true;
      stationGroup.add(anvilTop);

      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.18, 0),
        new THREE.MeshStandardMaterial({
          color: meta.hex,
          emissive: meta.hex,
          emissiveIntensity: 0.85,
          roughness: 0.28,
          metalness: 0.2,
        }),
      );
      core.position.set(0, 0.96, 0);
      core.castShadow = true;
      stationGroup.add(core);

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.38, 0.035, 6, 24),
        new THREE.MeshBasicMaterial({
          color: meta.hex,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
        }),
      );
      halo.rotation.x = Math.PI * 0.5;
      halo.position.y = 0.72;
      stationGroup.add(halo);

      const light = new THREE.PointLight(meta.hex, 2.2, 16);
      light.position.set(0, 1.06, 0);
      light.visible = false; // gated to ~55m by updateEnvironmentLod (light budget)
      stationGroup.userData.decorLight = lowDetail ? null : light;
      stationGroup.add(light);

      const stationProp = makeUpgradeStationProp(station.type, meta.hex);
      stationGroup.add(stationProp);

      const signTitle = station.type === 'hull_reinforcement'
        ? 'Hull Armor'
        : station.type === 'charged_cannons'
          ? 'Cannons'
          : 'Sail Speed';
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(2.05, 0.76),
        new THREE.MeshBasicMaterial({
          map: makeUpgradeSignTexture(signTitle, meta.effect, meta.hex),
          transparent: true,
          opacity: 0.94,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      sign.position.set(0, 1.86, 0);
      sign.renderOrder = 6;
      stationGroup.add(sign);

      const postMat = new THREE.MeshStandardMaterial({ color: 0x4d321c, roughness: 0.92 });
      for (const x of [-0.78, 0.78]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.32, 7), postMat);
        post.position.set(x, 1.05, -0.04);
        post.castShadow = true;
        stationGroup.add(post);
      }

      for (let rock = 0; rock < 5; rock++) {
        const angle = (rock / 5) * Math.PI * 2 + 0.28;
        const radius = 0.86 + (rock % 2) * 0.12;
        const stone = new THREE.Mesh(
          new THREE.DodecahedronGeometry(0.16 + (rock % 2) * 0.05, 0),
          stoneMat,
        );
        stone.position.set(Math.cos(angle) * radius, 0.02, Math.sin(angle) * radius);
        stone.scale.set(1.2, 0.8, 1);
        stone.castShadow = true;
        stone.receiveShadow = true;
        stationGroup.add(stone);
      }

      this.ctx.environment.add(stationGroup);
      this.ctx.upgradeStationMeshes.set(station.id, {
        root: stationGroup,
        core,
        halo,
        sign,
        light,
        type: station.type,
      });
    }

    for (const npc of island.npcs ?? []) {
      const npcRecord = this.buildStoryNpcMesh(npc);
      this.ctx.environment.add(npcRecord.root);
      this.ctx.npcMeshes.set(npc.id, npcRecord);
    }
  }

  buildStoryNpcMesh(npc: IslandNpc): NpcMeshRecord {
    const root = new THREE.Group();
    root.position.set(npc.position.x, npc.position.y, npc.position.z);

    const roleColor: Record<IslandNpc['role'], number> = {
      mysterious_stranger: 0x29364f,
      shipwright: 0x7b4a24,
      oracle: 0x3c4f37,
      gold_hoarder: 0x7a5a1c,
      bartender: 0x6f3320,
    };
    const body = makePlayerMesh(roleColor[npc.role], 'pirate', 'captain');
    body.rotation.y = npc.rotation;
    body.scale.setScalar(1.08);
    root.add(body);

    const rugColor: Record<IslandNpc['role'], number> = {
      mysterious_stranger: 0x26324d,
      shipwright: 0x70421d,
      oracle: 0x384a32,
      gold_hoarder: 0x6d4f19,
      bartender: 0x5a2a18,
    };
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 18),
      new THREE.MeshStandardMaterial({ color: rugColor[npc.role], roughness: 0.95, side: THREE.DoubleSide }),
    );
    rug.rotation.x = -Math.PI * 0.5;
    rug.position.y = 0.02;
    rug.receiveShadow = true;
    root.add(rug);

    // Outdoor vendors get a proper market STALL (canopy + counter) so they read
    // as little shops. The bartender works inside the tavern, so no stall there.
    if (npc.role !== 'bartender') {
      const stall = this.buildPropInstance('stall', new THREE.Vector3(-Math.sin(npc.rotation) * 0.95, 0, -Math.cos(npc.rotation) * 0.95), npc.rotation, 1);
      if (stall) { stall.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; }); root.add(stall); }
    }

    const propMat = new THREE.MeshStandardMaterial({ color: 0x6b4726, roughness: 0.96 });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb48335, roughness: 0.55, metalness: 0.6 });
    if (npc.role === 'shipwright') {
      const bench = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.28, 0.42), propMat);
      bench.position.set(-0.95, 0.32, -0.18);
      bench.castShadow = true;
      root.add(bench);
      for (let tool = 0; tool < 3; tool++) {
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.46), brassMat);
        handle.position.set(-1.25 + tool * 0.26, 0.52, -0.12 + tool * 0.06);
        handle.rotation.y = 0.45 + tool * 0.24;
        root.add(handle);
      }
    } else if (npc.role === 'oracle') {
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.5, 0.22, 8), propMat);
      table.position.set(-0.82, 0.34, -0.16);
      table.castShadow = true;
      root.add(table);
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 14, 10),
        new THREE.MeshStandardMaterial({ color: 0x8ed4ff, emissive: 0x4ea8ff, emissiveIntensity: 0.55, roughness: 0.2 }),
      );
      orb.position.set(-0.82, 0.63, -0.16);
      root.add(orb);
    } else if (npc.role === 'bartender') {
      // No rug — bartender stands behind the bar inside the tavern building.
      rug.visible = false;
      const tankard = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.3, 8), brassMat);
      tankard.position.set(0.55, 1.12, -0.05);
      tankard.castShadow = true;
      root.add(tankard);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 10, Math.PI), brassMat);
      handle.rotation.y = Math.PI * 0.5;
      handle.position.set(0.69, 1.12, -0.05);
      root.add(handle);
    } else {
      // Supply crate GLB (0.72³ footprint, origin at ground) with the old box fallback.
      const crateGlb = this.buildPropInstance('crate', new THREE.Vector3(-0.82, 0.02, -0.2), 0.35, 0.75);
      if (crateGlb) {
        root.add(crateGlb);
      } else {
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.52, 0.58), propMat);
        crate.position.set(-0.82, 0.28, -0.2);
        crate.castShadow = true;
        root.add(crate);
      }
      const chart = new THREE.Mesh(
        new THREE.PlaneGeometry(0.52, 0.34),
        new THREE.MeshStandardMaterial({ color: 0xd0b57f, roughness: 0.92, side: THREE.DoubleSide }),
      );
      chart.position.set(-0.82, 0.57, -0.2);
      chart.rotation.x = -Math.PI * 0.5;
      root.add(chart);
    }

    const light = new THREE.PointLight(0xf2b45b, 1.4, 12);
    light.position.set(0.36, 1.45, -0.18);
    light.visible = false; // gated to ~55m by updateEnvironmentLod (light budget)
    root.userData.decorLight = this.ctx.renderer.getQuality() === 'low' ? null : light;
    root.add(light);
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.26, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xd6a143, emissive: 0xff8a20, emissiveIntensity: 0.75, roughness: 0.7 }),
    );
    lantern.position.copy(light.position);
    root.add(lantern);

    return { root, body, light, baseY: npc.position.y, role: npc.role };
  }
}
