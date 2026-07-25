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
import type { Island, SeaRock } from '../../shared/types/index.js';
import { assets, type AssetName } from '../assets/AssetLibrary.js';
import { BIOME_PALETTES } from '../../shared/props.js';
import { getIslandMaxRadius, getIslandSurfacePoint, getIslandSurfaceY, isPointInsideIslandFootprint } from '../../shared/utils/index.js';
import { makeUpgradeSignTexture } from '../rendering/factories/TextureFactory.js';
import { makeUpgradeStationProp } from '../rendering/factories/MiscMeshFactory.js';
import type { IslandBuildCtx, IslandBuilderCtx } from './island/context.js';
import { buildCaves, makeCaveMouthCarver } from './island/CaveBuilder.js';
import { buildDock, buildDockClutter, buildTavern } from './island/DockBuilder.js';
import { applyFoliageSway, buildGroundCover, buildPropInstance, buildServerProps, buildStoryNpcMesh } from './island/PropScatterer.js';
import { buildCliffStrata, buildPeakMist, buildReefRing, buildRockSpires, buildTerraces, buildWaterfalls } from './island/TerrainFeatures.js';
import { buildVolcanicFx } from './island/VolcanicFx.js';
import { buildProxyTerrainMesh, buildTerrainMesh } from './island/TerrainMeshBuilder.js';

export type { ChestMeshRecord, NpcMeshRecord, UpgradeStationMeshRecord } from './island/context.js';

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

  /** Clone a GLB library prop and place it (see island/PropScatterer). Kept on
   *  the class because Game's environment FX place props through it too. */
  buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale = 1): THREE.Group | null {
    return buildPropInstance(type, position, yaw, scale);
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
      buildPropInstance,
      applyFoliageSway: (material) => applyFoliageSway(material, this.ctx),
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

    buildServerProps(ctx);

    buildGroundCover(ctx, terrain);

    buildDock(ctx);

    buildTavern(ctx);

    buildCaves(ctx);

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

    buildVolcanicFx(ctx);

    buildWaterfalls(ctx);

    buildCliffStrata(ctx);

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
        applyFoliageSway(bushAsset.material, this.ctx);
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

    buildDockClutter(ctx);

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

    buildReefRing(ctx);

    buildRockSpires(ctx);

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

    buildPeakMist(ctx);

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

    buildTerraces(ctx);

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
      const npcRecord = buildStoryNpcMesh(npc, this.ctx);
      this.ctx.environment.add(npcRecord.root);
      this.ctx.npcMeshes.set(npc.id, npcRecord);
    }
  }
}
