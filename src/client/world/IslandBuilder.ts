/**
 * The island CONDUCTOR. It owns three things and nothing else: the per-island
 * scratch every builder shares (palette, seeded rng, surface samplers — see
 * island/context.ts), the ORDER the builders run in (which is the island's
 * scene-graph order), and the LOD assembly that sorts the finished children
 * into the detail / micro / proxy tiers.
 *
 * Every mesh itself is built by a module under island/: terrain and its proxy,
 * caves, dock and tavern, server props and ground cover, volcanic FX, the
 * land's own features, the landmarks people left, the decor scatter, the
 * chest/barrel/station furniture, and the offshore sea stacks.
 *
 * State that the rest of Game reads each frame (mesh registries, foliage wind
 * uniforms, the environment group) is handed in by reference through
 * `IslandBuilderCtx` rather than duplicated here.
 */
import * as THREE from 'three';
import type { Island, SeaRock } from '../../shared/types/index.js';
import type { AssetName } from '../assets/AssetLibrary.js';
import { BIOME_PALETTES } from '../../shared/props.js';
import { getIslandMaxRadius, getIslandSurfacePoint, getIslandSurfaceY, isPointInsideIslandFootprint } from '../../shared/utils/index.js';
import type { IslandBuildCtx, IslandBuilderCtx } from './island/context.js';
import { buildCaves, makeCaveMouthCarver } from './island/CaveBuilder.js';
import { buildBarrelMeshes, buildChestMeshes, buildUpgradeStationMeshes } from './island/EntityMeshes.js';
import { buildSeaRockMesh } from './island/SeaRockBuilder.js';
import { buildDock, buildDockClutter, buildTavern } from './island/DockBuilder.js';
import { applyFoliageSway, buildGroundCover, buildPropInstance, buildServerProps, buildStoryNpcMesh } from './island/PropScatterer.js';
import { buildBeachDecor, buildCairns, buildInteriorDressing, buildPebbles, buildRockAndDriftDecor, buildTreesAndStrays, buildVinesAndStakes } from './island/DecorScatter.js';
import { buildBridges, buildLookoutPost, buildPirateCamp, buildRopeLadder, buildRuin, buildSecondaryWreck, buildStoneIdols, buildTrails } from './island/Landmarks.js';
import { buildCliffStrata, buildPeakMist, buildReefRing, buildRockSpires, buildTerraces } from './island/TerrainFeatures.js';
import { collapseIslandDecor } from './island/StaticBatcher.js';
import { buildWaterfalls } from './island/WaterfallBuilder.js';
import { buildVolcanicFx } from './island/VolcanicFx.js';
import { buildProxyTerrainMesh, buildTerrainMesh } from './island/TerrainMeshBuilder.js';
import { freezeStaticSubtree } from '../rendering/three-util.js';

export type { ChestMeshRecord, NpcMeshRecord, UpgradeStationMeshRecord } from './island/context.js';

export class IslandBuilder {
  constructor(private readonly ctx: IslandBuilderCtx) {}

  /** Sea-stack rocks build outside the island pipeline (see
   *  island/SeaRockBuilder); Game builds them straight from the snapshot. */
  buildSeaRockMesh(rock: SeaRock) {
    return buildSeaRockMesh(rock, this.ctx);
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

    // ── Static batching ──────────────────────────────────────────────────
    // Every piece above is scenery: bolted down, never animated, and drawn a
    // plank, a rung and a bollard at a time. The census put a single pier at 49
    // to 67 draw calls, a rope bridge at 150, a lookout at 24 — and five
    // islands in one wide shot at over a thousand calls of that alone. Merging
    // each piece's unnamed static sub-meshes by material takes them to one call
    // apiece with nothing removed from the screen. Runs here, after every
    // builder has contributed and BEFORE the tiers are assembled, so each child
    // is still exactly one placed piece. See island/StaticBatcher for the rules.
    collapseIslandDecor(group);

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

    // An island is scenery: placed once, never moved again, and nothing inside
    // it moves either — the palm sway is in the vertex shader, and the two FX
    // nodes that DO animate (a geyser's splash collar and vent core, a felled
    // palm) push their own world matrix through refreshFrozenChild.
    //
    // Freezing the group takes ~300–650 nodes per island off three's per-frame
    // world-matrix walk; twelve islands is ~6,800 of them, and profiling put
    // that walk at ~30% of frame CPU. Chests, barrels, stations, NPCs and
    // wildlife are parented to `environment`, not to this group, so they are
    // untouched by the freeze.
    freezeStaticSubtree(group);

    buildChestMeshes(ctx);

    buildBarrelMeshes(ctx);

    buildUpgradeStationMeshes(ctx);

    for (const npc of island.npcs ?? []) {
      const npcRecord = buildStoryNpcMesh(npc, this.ctx);
      this.ctx.environment.add(npcRecord.root);
      this.ctx.npcMeshes.set(npc.id, npcRecord);
    }
  }
}
