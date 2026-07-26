/**
 * Everything scattered ON the island: the server's replicated prop registry
 * (the palms, boulders and landmarks players actually collide with), the shared
 * GLB clone helper, the wind sway injected into instanced foliage, the
 * client-only ground cover (grass tufts, ferns, shells) and the story NPCs
 * standing at their stalls.
 */
import * as THREE from 'three';
import type { Island, IslandNpc, IslandProp, IslandPropType } from '../../../shared/types/index.js';
import { assets, type AssetName } from '../../assets/AssetLibrary.js';
import { BIOME_PALETTES, getPropGroundY } from '../../../shared/props.js';
import { makeFernFrondTexture, makeGrassBladeTexture } from '../../rendering/factories/TextureFactory.js';
import { registerBudgetLight } from '../../rendering/LightBudget.js';
import { makePlayerMesh } from '../../rendering/factories/PlayerMeshFactory.js';
import type { IslandBuildCtx, IslandBuilderCtx, NpcMeshRecord } from './context.js';
import type { TerrainBuild } from './TerrainMeshBuilder.js';

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

/**
 * Clone a GLB library prop and place it. Returns null when the asset failed
 * to load (callers keep their procedural fallback). Kept signature-stable so
 * a later server-driven prop registry can reuse it.
 */
export function buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale = 1): THREE.Group | null {
  const clone = assets.clone(type);
  if (!clone) return null;
  clone.position.copy(position);
  clone.rotation.y = yaw;
  clone.scale.setScalar(scale);
  return clone;
}

/** Inject a vertex wind-sway into an instanced foliage material: higher parts
 *  bend more, each instance offset by its world position so a grove ripples
 *  rather than swaying in lockstep. Applied once per shared material. */
export function applyFoliageSway(material: THREE.Material | THREE.Material[], host: IslandBuilderCtx) {
  if (Array.isArray(material)) {
    for (const m of material) applyFoliageSway(m, host);
    return;
  }
  const ud = material.userData as { swayApplied?: boolean };
  if (ud.swayApplied) return;
  ud.swayApplied = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFoliageTime = host.foliageTime;
    shader.uniforms.uFoliageWind = host.foliageWind;
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
function blendStoryPad(mesh: THREE.Mesh, island: Island) {
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

/** Render the SERVER's deterministic prop registry (island.props) — the same
 *  registry PhysicsSystem collides against every tick. Before this, the
 *  client scattered its own decorative palms/boulders while the real
 *  colliders stayed invisible: players got shoved by nothing and walked
 *  through every visible tree. Rendering the registry makes visuals ==
 *  colliders, and finally shows the roster landmarks (watchtowers, standing
 *  stones, wrecks) that were generated but never drawn. */
export function buildServerProps(ctx: IslandBuildCtx) {
  const { host, island, group, lowDetail } = ctx;
  const props = island.props ?? [];
  if (props.length === 0) return;
  const propSlots = new Map<number, { inst: THREE.InstancedMesh; index: number }>();
  host.islandPropInstances.set(island.id, propSlots);
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
      if (SWAYING_FOLIAGE.has(type)) applyFoliageSway(merged.material, host);
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
      const node = buildPropInstance(prop.type as AssetName, localPos, prop.yaw, prop.scale);
      if (!node) continue;
      node.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = !lowDetail;
          obj.receiveShadow = true;
          blendStoryPad(obj, island);
        }
      });
      group.add(node);
      if (prop.type === 'campfire') {
        host.registerLanternEmitter(group, localPos.x, localPos.y + 0.4, localPos.z, 'campfire');
      } else if (prop.type === 'lantern_post') {
        host.registerLanternEmitter(group, localPos.x, localPos.y + 2.1, localPos.z, 'lantern');
      } else if (prop.type === 'widow_memorial') {
        // The widow's kept flame — must read from the sea at night.
        host.registerLanternEmitter(group, localPos.x, localPos.y + 3.0, localPos.z, 'lantern');
      } else if (prop.type === 'mermaid_shrine') {
        // Offering candles at the throne's base.
        host.registerLanternEmitter(group, localPos.x, localPos.y + 0.7, localPos.z, 'campfire');
      }
    }
  }
}

/** Ground cover: one InstancedMesh each of cross-plane grass tufts over the
 *  grassy interior, arched fern fronds in the shaded inner jungle band, and
 *  seashell flecks on the wet sand. Deterministic from the profile seed; culled
 *  with the micro tier past ~260m; zero colliders (ankle-high). */
export function buildGroundCover(ctx: IslandBuildCtx, terrain: TerrainBuild) {
  const { island, group, r, rng, lowDetail, surfacePoint, carveCaveMouth, paletteGrass, paletteFoliage } = ctx;
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
}

export function buildStoryNpcMesh(npc: IslandNpc, host: IslandBuilderCtx): NpcMeshRecord {
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
    const stall = buildPropInstance('stall', new THREE.Vector3(-Math.sin(npc.rotation) * 0.95, 0, -Math.cos(npc.rotation) * 0.95), npc.rotation, 1);
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
    const crateGlb = buildPropInstance('crate', new THREE.Vector3(-0.82, 0.02, -0.2), 0.35, 0.75);
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
  root.userData.decorLight = host.renderer.getQuality() === 'low' ? null : light;
  registerBudgetLight(light);
  root.add(light);
  const lantern = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.26, 0.18),
    new THREE.MeshStandardMaterial({ color: 0xd6a143, emissive: 0xff8a20, emissiveIntensity: 0.75, roughness: 0.7 }),
  );
  lantern.position.copy(light.position);
  root.add(lantern);

  return { root, body, light, baseY: npc.position.y, role: npc.role };
}
