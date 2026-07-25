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
import { buildBeachDecor, buildCairns, buildInteriorDressing, buildPebbles, buildRockAndDriftDecor, buildTreesAndStrays, buildVinesAndStakes } from './island/DecorScatter.js';
import { buildBridges, buildLookoutPost, buildPirateCamp, buildRopeLadder, buildRuin, buildSecondaryWreck, buildStoneIdols, buildTrails } from './island/Landmarks.js';
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

    buildRockAndDriftDecor(ctx);

    buildBeachDecor(ctx);

    // (Snow on tall mountains is now painted into the terrain vertex colours
    // above — the snow line — instead of a floating cone + flat patches.)

    buildVolcanicFx(ctx);

    buildWaterfalls(ctx);

    buildCliffStrata(ctx);

    // (Procedural stone arch removed — rock_arch is a real Blender GLB
    // placed by the server prop registry now.)

    buildLookoutPost(ctx);

    buildPirateCamp(ctx);

    buildCairns(ctx);

    // NOTE: the client-only bedrock CRAG mass generator that used to live here
    // was removed — crags are now authored props in the SERVER registry and
    // render automatically through buildServerProps(). Rebuilding them here as
    // well produced doubled, mismatched outcrops on every mountain/rocky isle.

    buildPebbles(ctx);

    buildInteriorDressing(ctx);

    buildTreesAndStrays(ctx);

    buildDockClutter(ctx);

    buildStoneIdols(ctx);

    buildVinesAndStakes(ctx);

    buildRopeLadder(ctx);

    buildSecondaryWreck(ctx);

    buildTrails(ctx);

    buildReefRing(ctx);

    buildRockSpires(ctx);

    buildBridges(ctx);

    buildPeakMist(ctx);

    buildRuin(ctx);

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
