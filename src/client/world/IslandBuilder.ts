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
import type { Island, IslandProp, IslandPropType, SeaRock } from '../../shared/types/index.js';
import { assets, type AssetName } from '../assets/AssetLibrary.js';
import { getPropGroundY } from '../../shared/props.js';
import type { Renderer } from '../rendering/Renderer.js';

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
};

/** Instanced prop types that bend in the wind (palms + soft foliage; not rocks). */
const SWAYING_FOLIAGE: ReadonlySet<string> = new Set([
  'palm_a', 'palm_b', 'palm_c', 'palm_tall', 'palm_ground',
  'fern_plant', 'bush', 'bush_berry', 'flower_bush', 'wildflowers', 'flower_patch',
]);

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
}
