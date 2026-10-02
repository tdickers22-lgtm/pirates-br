/**
 * What the land itself grew: sedimentary strata bands, the offshore reef ring,
 * jagged rock spires, the cloud collar on a tall summit, and the odd flat
 * terrace ledge. (Cascades moved out to island/WaterfallBuilder — a fall is now
 * a whole composition of rock, water and mist, not a ribbon.)
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import type { IslandBuildCtx } from './context.js';
import { buildCliffKit } from './CliffKitBuilder.js';
import { ensureMeshGround, snapToDrawnGround } from './GroundTruth.js';

/**
 * THE LAST UNPAINTED ROCK FAMILY.
 *
 * The cave stone, the sea stacks, the boulder GLBs and (this wave) the fall's
 * sculpted rock all grew a fragment-scale albedo pass. These three did not: the
 * strata slabs, the spires and the spire rubble are still a solid tone on a
 * primitive — a Box, a Cone, a Dodecahedron — with flat shading and nothing
 * else. On the bone isles, whose pale sand throws every dark tone into relief,
 * that reads exactly as the audit called it: untextured dark BOXES and CONES
 * lying about the ground, and dark shark-fin triangles on the skyline.
 *
 * Same idiom as `paintCaveRock` / the sea-stack strata, kept generic so one
 * program serves all three families:
 *   · bedding planes on a ~1.6m pitch, warped and DIPPED so a boxy slab is
 *     layered rather than striped, and the four faces of a cone disagree;
 *   · two mottle octaves plus a grain octave, so there is something to read at
 *     3m as well as at 30m;
 *   · a sun-bleached upper face and lichen in the shaded bedding, which is what
 *     actually stops a dark stone from reading as a black solid;
 *   · a floor under the darkening, so no face of this family can go to pitch.
 *
 * ONE PROGRAM, NOT NINE. Every call site here builds the SAME GLSL and differs
 * only in how hard the sun has bleached the upper faces — and until this was
 * measured, each of them also handed three a different `customProgramCacheKey`,
 * so strata-0, strata-1, strata-2, reef-dark, reef-wet, spire, spire-rubble and
 * terrace-ledge were eight separate shader programs of identical source. The
 * census caught six of them linking inside a drawn frame in a single 90-second
 * session, 10.2 s of joins between them. `bleach` is a float. A float that
 * varies is a uniform, not a define, and a uniform costs nothing per frame and
 * nothing per program — the whole family now links once, and whichever of them
 * the player sails past first pays for all the rest.
 *
 * The uniform object is per MATERIAL (each closure makes its own and hands it to
 * `shader.uniforms`), so sharing the program does not share the value.
 */
function paintFeatureRock(mat: THREE.MeshStandardMaterial, name: string, bleach = 0.30) {
  const bleachUniform = { value: bleach };
  mat.name = mat.name || name;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFeatBleach = bleachUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFeatW;\nvarying vec3 vFeatN;\n')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + 'vFeatW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
        + 'vFeatN = normalize(mat3(modelMatrix) * objectNormal);\n',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vFeatW;\nvarying vec3 vFeatN;\nuniform float uFeatBleach;\n'
        + 'float ftHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n'
        + 'float ftNoise(vec2 p) {\n'
        + '  vec2 i = floor(p); vec2 f = fract(p);\n'
        + '  vec2 u = f * f * (3.0 - 2.0 * f);\n'
        + '  float a = ftHash(i), b = ftHash(i + vec2(1.0, 0.0));\n'
        + '  float c = ftHash(i + vec2(0.0, 1.0)), d = ftHash(i + vec2(1.0, 1.0));\n'
        + '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n'
        + '}\n',
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        + 'float ftWarp = ftNoise(vFeatW.xz * 0.42);\n'
        + 'float ftDip = dot(vFeatW.xz, vec2(0.26, -0.19));\n'
        + 'float ftBed = 0.5 + 0.5 * sin(vFeatW.y * 3.9 + ftDip + ftWarp * 5.6);\n'
        + 'float ftM1 = ftNoise(vFeatW.xz * 1.15 + vFeatW.y * 0.45);\n'
        + 'float ftM2 = ftNoise(vFeatW.xz * 4.30 - vFeatW.y * 1.30);\n'
        + 'float ftGrit = ftNoise(vFeatW.xz * 13.0 + vFeatW.y * 5.0);\n'
        // Centred near 1.0, not below it: this pass is meant to give the stone
        // structure, not to sink its albedo — the family's whole failure was
        // being too dark to read as a surface.
        + 'float ftShade = 0.88 + 0.26 * ftBed * (0.5 + 0.5 * ftM1) + 0.18 * (ftM2 - 0.5) + 0.12 * (ftGrit - 0.5);\n'
        + 'diffuseColor.rgb *= clamp(ftShade, 0.72, 1.45);\n'
        // Weathering by ASPECT: the up-facing planes bleach, the undercuts hold
        // damp shadow. On a cone this is what turns a silhouette into a rock.
        + 'diffuseColor.rgb += vec3(0.100, 0.093, 0.074) * uFeatBleach * smoothstep(0.25, 0.95, vFeatN.y) * (0.45 + 0.55 * ftM1);\n'
        + 'diffuseColor.rgb *= 1.0 - 0.16 * smoothstep(-0.15, -0.85, vFeatN.y);\n'
        // Lichen in the shaded bedding planes, mineral warmth in the proud ones.
        + 'diffuseColor.rgb += vec3(-0.010, 0.026, -0.012) * smoothstep(0.62, 0.16, ftBed) * ftM1;\n'
        + 'diffuseColor.rgb += vec3(0.034, 0.021, 0.004) * smoothstep(0.60, 0.96, ftM2);\n'
        // The floor. A stone that reaches pure black has stopped being a
        // surface — that is the whole finding this family failed.
        + 'diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.052, 0.048, 0.042));\n',
      )
      // `roughnessFactor` is not declared until this chunk, so the polish on the
      // wind-scoured faces has to be applied here rather than up with the albedo.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + 'roughnessFactor = clamp(roughnessFactor - 0.20 * smoothstep(0.55, 0.95, ftM2), 0.42, 1.0);\n',
      );
  };
  // One key for the whole family — see the note above. Changing this back to a
  // per-call-site string re-mints eight programs of identical source.
  mat.customProgramCacheKey = () => 'pirates-feature-rock';
}

/** Layered cliff strata — exposed rock bands wrapping high cliffs. (Skipped on
 *  mountains: the sheer spires changed the slopes those slabs were sampled
 *  against, leaving them floating mid-air.) */
export function buildCliffStrata(ctx: IslandBuildCtx) {
  // b4.6d: the box slabs are gone. Strata beds (strata_slab_a/b/c), cliff faces, overhangs, shelves,
  // arches, spires, reefs and kit sea stacks are the Blender cliff kit now, placed on the served
  // world (island.kitPieces) and drawn here on every tier, since their hull colliders are live.
  buildCliffKit(ctx);
}

/** Reef ring — sharp dark rocks just offshore.
 *
 *  A reef rock is the one piece of island scenery whose ground is UNDERWATER,
 *  and it used to be placed by picking a radius first and then asking the
 *  ANALYTIC heightfield what was down there. Two lies compounded: the analytic
 *  seabed runs above the drawn one (the mesh triangles are chords under it),
 *  and past the shelf edge there is nothing under a reef rock at all — the
 *  live audit found rocks hanging 5.5 m over the drawn seabed with their foam
 *  ring painted on the water below them. In the shallows the sand shows
 *  straight through the water, so that gap is not a technicality.
 *
 *  So the DEPTH picks the radius now, not the other way round: walk in along
 *  the rock's own bearing until the DRAWN seabed is shallow enough that this
 *  rock, standing on it and sunk a fifth, breaks the surface the way it was
 *  meant to. A bearing with nothing but deep water on it grows no reef. */
export function buildReefRing(_ctx: IslandBuildCtx) {
  // b4.6d: reef_a/b/c from the cliff kit (buildCliffKit) replace the dodecahedron reef ring.
}

/** Sharp rock spires — jagged peaks for mountain/rocky islands. */
export function buildRockSpires(_ctx: IslandBuildCtx) {
  // b4.6d: spire_a/b/c and basalt_columns_a from the cliff kit (buildCliffKit) replace the cones.
}

/**
 * Peak mist — tall summits wear a slow ring of cloud (SoT reference).
 *
 * WHY THE COLLAR USED TO CUT INTO THE MOUNTAIN. The ring was laid out blind: six
 * sprites at a fixed 7-16m from the summit axis and 4-9m below the peak, each one
 * 9-17m wide. On a real summit that band is still SOLID ROCK — the cone has barely
 * begun to open out that close under its own peak — so most of the ring was placed
 * inside the mountain. A Sprite is a camera-facing quad with depth TESTING on
 * (only depthWrite is off), so a buried sprite does not vanish, it gets sliced by
 * the terrain's depth: a soft round cloud with one dead-straight edge across it,
 * which is what the night-caldera shot photographed.
 *
 * There is no depth texture in this renderer to soft-fade against, so the fix is
 * geometric, and it is the one the summit's own shape dictates: for each sprite,
 * march OUTWARD from the summit axis at its own azimuth until the drawn hillside
 * has actually fallen below the height the sprite wants to sit at, then stand off
 * by the sprite's visible radius. The cloud ends up hugging the slope from the
 * outside — where a cloud collar belongs — instead of being embedded in it. A
 * sprite that can find no clear air inside the island's own footprint is dropped
 * rather than drawn buried.
 */
export function buildPeakMist(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail } = ctx;
  {
    const profileMist = island.profile;
    const peakLocalX = Math.cos(profileMist.primaryHillAngle) * profileMist.primaryHillOffset * profileMist.footprintX;
    const peakLocalZ = Math.sin(profileMist.primaryHillAngle) * profileMist.primaryHillOffset * profileMist.footprintZ;
    const peakY = getIslandSurfaceY(island, island.position.x + peakLocalX, island.position.z + peakLocalZ);
    // The hillside the sprite is judged against has to be the one it is DRAWN
    // against, for the same reason the spires and the falls moved onto it.
    const ground = ensureMeshGround(ctx);
    const drawnY = (lx: number, lz: number): number => {
      const y = ground?.heightAt(lx, lz);
      return y === null || y === undefined
        ? getIslandSurfaceY(island, lx + island.position.x, lz + island.position.z)
        : y;
    };
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
      /** How much of a sprite's half-width actually paints: the gradient is at
       *  0.22 alpha by 0.6 of the radius and gone by 1.0, so the part that can be
       *  caught by a depth slice is the inner ~60%. Standing off by that much
       *  clears the visible disc without flinging the collar off the mountain. */
      const VISIBLE_FRACTION = 0.30;
      /** Air, not a graze: the ground under the sprite's centre must be at least
       *  this far below it, or a bump in the slope re-buries it. */
      const HEADROOM = 2.5;
      for (let m = 0; m < 6; m++) {
        const ma = (m / 6) * Math.PI * 2 + rng(m * 983) * 0.8;
        const ms = 9 + rng(m * 1009) * 8;
        const mistY = peakY - 4 - rng(m * 997) * 5;
        // March out along this azimuth to the first radius whose drawn ground has
        // dropped clear of the sprite's height. Start where the old ring started,
        // so a summit that IS open at 7m keeps the tight collar it always had.
        const standoff = ms * VISIBLE_FRACTION;
        const maxR = r * 1.05;
        let mr = -1;
        for (let probe = 7; probe <= maxR; probe += 1.5) {
          const px = peakLocalX + Math.cos(ma) * probe;
          const pz = peakLocalZ + Math.sin(ma) * probe;
          if (drawnY(px, pz) <= mistY - HEADROOM) { mr = probe + standoff; break; }
        }
        // No clear air anywhere on this bearing inside the island: a sprite here
        // could only ever be drawn sliced, so it is not drawn at all.
        if (mr < 0 || mr > maxR + standoff) continue;
        const mistSprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: mistTex,
          transparent: true,
          opacity: 0.4 + rng(m * 977) * 0.2,
          depthWrite: false,
        }));
        mistSprite.position.set(
          peakLocalX + Math.cos(ma) * mr,
          mistY,
          peakLocalZ + Math.sin(ma) * mr,
        );
        mistSprite.scale.set(ms, ms * 0.55, 1);
        group.add(mistSprite);
      }
    }
  }
}

/** Flat terrace ledges cut into the ridge flank. */
/** A cut rock ledge: an irregular rounded slab (w x t x d, centred), not a box. */
function ledgeGeometry(w: number, t: number, d: number, jitter: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const wob = 1 + 0.08 * Math.sin(a * 3 + jitter * 6.28);
    const cx = Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 0.5) * w * 0.5 * wob;
    const cz = Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 0.5) * d * 0.5 * wob;
    if (k === 0) shape.moveTo(cx, cz); else shape.lineTo(cx, cz);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t * 0.6, bevelEnabled: true, bevelThickness: t * 0.2, bevelSize: 0.06, bevelSegments: 1, curveSegments: 1 });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, t * 0.3, 0); // extrude+bevel spans y -0.8t..0.2t after the turn: centre it
  geo.computeVertexNormals();
  return geo;
}

export function buildTerraces(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, SURFACE_ABOVE_WATER } = ctx;
  if (!lowDetail) {
    const ground = ensureMeshGround(ctx);
    const terraceMat = new THREE.MeshStandardMaterial({ color: 0xa48d62, roughness: 0.98 });
    paintFeatureRock(terraceMat, 'pirates-terrace-ledge', 0.30);
    const terraceCount = r > 58 ? 3 : 2;
    for (let i = 0; i < terraceCount; i++) {
      const angle = island.profile.ridgeAxis + (i - 1) * 0.46 + (rng(i * 1103 + islandSeed) - 0.5) * 0.18;
      const pos = surfacePoint(0.34 + i * 0.08 + rng(i * 1109 + islandSeed) * 0.06, angle, 0.035);
      if (pos.y < 1.4 || !isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) continue;
      // `surfacePoint` samples the analytic field, which can sit half a metre
      // above the rendered triangle chord at a terrace lip. A ledge is rock
      // cut INTO that visible hillside, not a shelf hovering over it.
      snapToDrawnGround(ground, pos, 0.035);
      const ledge = new THREE.Mesh(
        ledgeGeometry(3.8 + rng(i * 1117 + islandSeed) * 2.2, 0.12, 1.0 + rng(i * 1123 + islandSeed) * 0.65, rng(i * 1137 + islandSeed)),
        terraceMat,
      );
      ledge.position.copy(pos);
      ledge.rotation.y = -angle + Math.PI * 0.5;
      ledge.rotation.z = (rng(i * 1129 + islandSeed) - 0.5) * 0.08;
      ledge.castShadow = true;
      ledge.receiveShadow = true;
      group.add(ledge);
    }
  }
}
