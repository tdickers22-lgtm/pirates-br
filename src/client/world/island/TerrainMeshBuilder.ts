/**
 * The island heightfield mesh: geometry, per-vertex colour/material class, the
 * volcanic magma + summit attributes, the fragment-scale detail shader, the
 * underwater plinth skirt, and the low-res proxy the distance LOD swaps in.
 *
 * Everything here is pure geometry/colour work off the shared heightfield —
 * `IslandBuilder` owns the call order and the shared per-island scratch.
 */
import * as THREE from 'three';
import { getIslandCoastWeights } from '../../../shared/utils/index.js';
import type { IslandBuildCtx, IslandBuilderCtx } from './context.js';

/** Terrain-derived values the rest of the island build reads back: the colour
 *  bands and height references the decor scatter and the proxy LOD key off. */
export type TerrainBuild = {
  readonly seaBase: number;
  readonly peakEst: number;
  readonly shoreRingSpan: number;
  readonly rockSlopeColor: THREE.Color;
  readonly wetSandColor: THREE.Color;
  readonly submergedColor: THREE.Color;
};

/**
 * FRAGMENT-SCALE ground detail for the island terrain material.
 *
 * The terrain mesh carries vertices 4-8m apart, so 100% of its read used to
 * come from per-vertex colour: at 2m every biome collapsed into one flat
 * airbrushed smear ("vinyl"), and the cliff plinths rendered as featureless
 * whale-backs. This injects a world-space procedural detail pass that runs
 * per PIXEL — a handful of ALU ops, no textures, no extra lights, no geometry
 * and no contact with `getIslandSurfaceY` (purely a colour/roughness edit):
 *
 *  • 3 octaves of value noise (~1.8m mottle, ~0.5m patches, ~0.09m grain)
 *    keyed per material class from `aMat` (sand / grass / rock / ash), so
 *    sand speckles + ripples, grass patches, rock grains and ash chars.
 *  • Slope-gated sedimentary STRATA on steep faces — the whale-back killer.
 *  • A wet-sand band that breathes with the swell, plus an underwater floor
 *    tint and caustic mottle so the walk-in slope reads through the water.
 *  • Volcanic: hairline magma cracks evaluated per-pixel (the per-vertex
 *    field smeared them into ~10m glow bars) with the glow confined to the
 *    crack core, and a molten caldera pool from `aSummit`.
 */
function applyTerrainDetail(material: THREE.MeshStandardMaterial, volcanic: boolean, host: IslandBuilderCtx) {
  const pulse = host.magmaPulseUniform;
  const time = host.foliageTime;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrTime = time;
    if (volcanic) shader.uniforms.uMagmaPulse = pulse;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'attribute float aMat;\n'
        + 'varying vec3 vTerrWorld;\n'
        + 'varying float vTerrMat;\n'
        + 'varying float vTerrSlope;\n'
        + (volcanic ? 'attribute float aMagma;\nattribute float aSummit;\nvarying float vMagmaGate;\nvarying float vSummit;\n' : ''),
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + 'vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n'
        + 'vTerrMat = aMat;\n'
        + 'vTerrSlope = clamp(1.0 - normalize(objectNormal).y, 0.0, 1.0);\n'
        + (volcanic ? 'vMagmaGate = aMagma;\nvSummit = aSummit;\n' : ''),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'uniform float uTerrTime;\n'
        + 'varying vec3 vTerrWorld;\n'
        + 'varying float vTerrMat;\n'
        + 'varying float vTerrSlope;\n'
        + (volcanic ? 'uniform float uMagmaPulse;\nvarying float vMagmaGate;\nvarying float vSummit;\n' : '')
        + 'float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n'
        + 'float tNoise(vec2 p) {\n'
        + '  vec2 i = floor(p); vec2 f = fract(p);\n'
        + '  vec2 u = f * f * (3.0 - 2.0 * f);\n'
        + '  float a = tHash(i), b = tHash(i + vec2(1.0, 0.0));\n'
        + '  float c = tHash(i + vec2(0.0, 1.0)), d = tHash(i + vec2(1.0, 1.0));\n'
        + '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n'
        + '}\n',
      )
      // Detail runs AFTER the vertex colour is folded into diffuseColor.
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        + 'vec2 tP = vTerrWorld.xz;\n'
        // Each octave samples a ROTATED lattice. A value-noise grid shares the
        // world axes, and three co-aligned octaves stack their cell edges into
        // a visible checkerboard on flat ground (caught in verification).
        + 'mat2 tR1 = mat2(0.87, -0.50, 0.50, 0.87);\n'
        + 'mat2 tR2 = mat2(0.36, 0.93, -0.93, 0.36);\n'
        + 'float nMid = tNoise(tP * 0.55);\n'                    // ~1.8m mottle
        + 'float nFine = tNoise(tR1 * tP * 2.1);\n'              // ~0.5m patches
        + 'float nGrain = tNoise(tR2 * tP * 8.5);\n'             // ~0.12m grain
        // Tent weights over the 0..3 material axis: adjacent classes crossfade.
        + 'float mC = clamp(vTerrMat, 0.0, 3.0);\n'
        + 'float wSand = max(0.0, 1.0 - abs(mC - 0.0));\n'
        + 'float wGrass = max(0.0, 1.0 - abs(mC - 1.0));\n'
        + 'float wRock = max(0.0, 1.0 - abs(mC - 2.0));\n'
        + 'float wAsh = max(0.0, 1.0 - abs(mC - 3.0));\n'
        // Sand: fine grain speckle + shallow wind/tide ripple bands.
        + 'float ripple = sin(dot(tP, vec2(0.86, 0.51)) * 4.4 + nMid * 4.0);\n'
        + 'float dSand = (nGrain - 0.5) * 0.34 + (nFine - 0.5) * 0.12 + ripple * 0.06;\n'
        // Grass: broad patchiness (blade clumps), light grain.
        + 'float dGrass = (nMid - 0.5) * 0.34 + (nFine - 0.5) * 0.28 + (nGrain - 0.5) * 0.18;\n'
        // Rock: crystalline grain + a touch of mottle.
        + 'float dRock = (nFine - 0.5) * 0.34 + (nGrain - 0.5) * 0.28 + (nMid - 0.5) * 0.16;\n'
        // Ash: high-contrast char/clinker.
        + 'float dAsh = (nFine - 0.5) * 0.44 + (nGrain - 0.5) * 0.36;\n'
        + 'float detail = dSand * wSand + dGrass * wGrass + dRock * wRock + dAsh * wAsh;\n'
        // Sedimentary STRATA on steep faces — horizontal bands that follow the
        // rock face without moving a single vertex. The cliff/whale-back fix.
        // Heavily noise-warped and shallow: an un-warped low-frequency band
        // reads as zebra stripes painted across a big cone (seen in review).
        + 'float steep = smoothstep(0.34, 0.62, vTerrSlope);\n'
        + 'float strataW = sin(vTerrWorld.y * 2.5 + nMid * 6.5 + nFine * 2.4);\n'
        + 'float strata = smoothstep(-0.40, 0.35, strataW) - 0.5;\n'
        // ...and only on ROCK/ASH ground: contour bands running across a green
        // grass spire read as topographic lines, not sedimentary layers.
        + 'float strataMat = clamp(wRock + wAsh + wSand * 0.3, 0.0, 1.0);\n'
        + 'detail += strata * 0.17 * steep * strataMat;\n'
        + 'diffuseColor.rgb *= clamp(1.0 + detail, 0.35, 1.9);\n'
        // Hue character: sun-bleached sand warms, grass patches yellow off,
        // strata bands run ochre, ash cools toward blue-grey clinker.
        + 'diffuseColor.rgb += vec3(0.030, 0.018, -0.012) * (nGrain - 0.5) * wSand;\n'
        + 'diffuseColor.rgb += vec3(0.045, 0.038, -0.030) * (nMid - 0.5) * wGrass;\n'
        + 'diffuseColor.rgb += vec3(0.032, 0.019, 0.003) * strata * steep * strataMat;\n'
        + 'diffuseColor.rgb += vec3(-0.012, -0.006, 0.014) * (nFine - 0.5) * wAsh;\n'
        // ── Shore: wet-sand band whose upper edge breathes with the swell ──
        + 'float wetLine = 1.05 + 0.30 * sin(uTerrTime * 0.55) + 0.12 * sin(uTerrTime * 0.23 + 1.7);\n'
        + 'float wet = smoothstep(wetLine + 0.45, wetLine - 0.65, vTerrWorld.y);\n'
        + 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.58, 0.63, 0.69), wet * 0.88);\n'
        // ── Submerged floor: keep the terrain read going under the water ──
        + 'float subm = smoothstep(-0.15, -2.6, vTerrWorld.y);\n'
        + 'float caustic = sin(vTerrWorld.x * 1.15 + uTerrTime * 0.7) * sin(vTerrWorld.z * 0.97 - uTerrTime * 0.55);\n'
        + 'diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, vec3(0.10, 0.30, 0.33), 0.55), subm);\n'
        + 'diffuseColor.rgb *= 1.0 + caustic * 0.16 * (1.0 - subm) * step(vTerrWorld.y, 0.6) + caustic * 0.10 * subm;\n'
        + (volcanic
          ? // Hairline magma cracks, per pixel. Two crossed sine fields sharpened
            // HARD so only the crack CORE lights; the flanks stay charred basalt.
            'float vein = 0.0;\n'
            + 'if (vMagmaGate > 0.004) {\n'
            + '  float c1 = sin(vTerrWorld.x * 0.224 + sin(vTerrWorld.z * 0.112) * 2.2);\n'
            + '  float c2 = sin(vTerrWorld.z * 0.208 - sin(vTerrWorld.x * 0.098) * 2.0);\n'
            + '  float c3 = sin(vTerrWorld.x * 0.496 - sin(vTerrWorld.z * 0.432) * 1.6);\n'
            + '  float c4 = sin(vTerrWorld.z * 0.464 + sin(vTerrWorld.x * 0.528) * 1.5);\n'
            + '  float coarse = pow(max(0.0, 1.0 - min(abs(c1), abs(c2))), 46.0);\n'
            + '  float fine = pow(max(0.0, 1.0 - min(abs(c3), abs(c4))), 58.0) * 0.7;\n'
            // Cracks are INTERMITTENT: an unbroken glowing line running the
            // length of an island reads as a racing stripe, not fractured rock.
            + '  float breakUp = smoothstep(0.30, 0.72, nMid * 0.6 + nFine * 0.4);\n'
            // ...and only the genuinely elevated cone cracks open; the shore
            // flank stays cold basalt (which the ash tint already sells).
            + '  float lift = smoothstep(9.0, 22.0, vTerrWorld.y);\n'
            + '  vein = min(1.0, coarse + fine) * vMagmaGate * breakUp * lift;\n'
            + '  diffuseColor.rgb *= 1.0 - vein * 0.55;\n'   // hot rim: rock darkens at the crack
            + '}\n'
          : ''),
      )
      // Wet rock/sand gains a specular sheen (roughness drops); the same band
      // that darkens the albedo lifts the highlight, which is what actually
      // sells "the tide just went out" at eye level.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + 'roughnessFactor = mix(roughnessFactor, 0.30, clamp(wet * 0.9 + subm * 0.7, 0.0, 1.0));\n',
      );
    if (volcanic) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + 'float veinCore = pow(vein, 2.4);\n'
        + 'if (veinCore > 0.002) {\n'
        + '  vec3 mc = mix(vec3(0.95, 0.16, 0.02), vec3(1.0, 0.72, 0.16), clamp(veinCore * 1.6, 0.0, 1.0));\n'
        + '  totalEmissiveRadiance += mc * veinCore * uMagmaPulse * 1.1;\n'
        + '}\n'
        + 'if (vSummit > 0.004) {\n'
        + '  float pool = vSummit * (0.75 + 0.25 * (nMid - 0.5) * 2.0);\n'
        + '  totalEmissiveRadiance += mix(vec3(0.95, 0.22, 0.03), vec3(1.0, 0.75, 0.20), clamp(pool * 1.6, 0.0, 1.0)) * pool * uMagmaPulse * 1.4;\n'
        + '}\n',
      );
    }
  };
  // One program per variant — not one per island — so shader compilation
  // doesn't churn across 14 island builds.
  material.customProgramCacheKey = () => (volcanic ? 'pirates-terrain-detail-volcanic' : 'pirates-terrain-detail');
}

export function buildTerrainMesh(ctx: IslandBuildCtx): TerrainBuild {
  const {
    host, island, group, r, rng, lowDetail, visualDetail, surfacePoint, carveCaveMouth,
    isVolcanic, islandMaxR, whiteSand,
    sandColor, beachColor, cliffColor, grassColor, jungleColor, peakColor, mudColor, paletteRock,
  } = ctx;
  const terrainPositions: number[] = [];
  const terrainIndices: number[] = [];
  // Mesh density scales with the island's real footprint so the shared
  // heightfield's fbm knolls, ridged cliff bands, and 2.4-6m terraces
  // actually resolve instead of aliasing into a smooth dome. A 56x160 cap is
  // ~9k verts — trivial for a landmark mesh.
  const radialDetailStep = lowDetail ? 8 : visualDetail < 0.85 ? 5.5 : 4;
  const angularDetailStep = lowDetail ? 11 : visualDetail < 0.85 ? 7 : 5;
  const radialSegments = THREE.MathUtils.clamp(Math.round(islandMaxR / radialDetailStep), 16, 60);
  const angularSegments = THREE.MathUtils.clamp(Math.round((Math.PI * 2 * islandMaxR) / angularDetailStep), 48, 176);
  // Extra rings past the footprint follow the shared heightfield UNDERWATER
  // (beach slides to −3m by distRatio ~1.15) so sand visibly walks into the
  // sea — the old cap stopped at 1.0 and hid the walk-in slope behind a
  // vertical rock curtain.
  const shoreRings = lowDetail ? 3 : 5;
  const shoreRingSpan = 0.16;
  const totalRings = radialSegments + shoreRings;
  const ringDistRatio = (ring: number): number => ring <= radialSegments
    ? (ring === 0 ? 0 : Math.pow(ring / radialSegments, 0.9))
    : 1 + ((ring - radialSegments) / shoreRings) * shoreRingSpan;
  const terrainColor = new THREE.Color();
  const scratchColor = new THREE.Color();
  const rockSlopeColor = paletteRock.clone().multiplyScalar(0.8);
  const ashCharcoal = new THREE.Color(0x2b2621);
  /** Vein GATE (smooth, interpolates cleanly) — the crack field itself is
   *  evaluated per-PIXEL in the fragment shader, so veins read as hairline
   *  cracks instead of the 10m airbrushed smears per-vertex storage produced. */
  const terrainMagma: number[] = [];
  /** Caldera core glow (the molten tip), kept separate from the vein gate so
   *  the summit stays a solid pool rather than a cracked field. */
  const terrainSummit: number[] = [];
  /** Fragment-detail material class per vertex: 0=sand, 1=grass, 2=rock, 3=ash.
   *  Interpolates between neighbours, and the shader blends the two adjacent
   *  grain characters, so transitions stay smooth. */
  const terrainMatClass: number[] = [];
  // Snow on tall NON-volcanic mountains: whiten the summit above the snow line
  // as part of the terrain itself (no floating cone). Volcanoes stay bare rock.
  // A tall mountain reads as craggy grey STONE with grass lower down — snow is
  // only ever a thin dusting on the very tip of a genuinely towering peak (the
  // old low, greedy band whitewashed the whole summit into a smooth blob).
  const isMountainColor = island.profile.terrainStyle === 'mountain';
  const isSnowy = isMountainColor
    && !isVolcanic
    && (island.profile.peakBoost ?? 0) > 0.95;
  const snowColor = new THREE.Color(0xeef3fb);


  // Per-vertex carve depth (parallel to terrainPositions) — drives the cut
  // faces' ROCK recolor in the color pass below (they'd read as floating
  // grass-green slabs otherwise) and lets decor placement skip the trench.
  const mouthCarveDepth: number[] = [];
  for (let ring = 0; ring <= totalRings; ring++) {
    const distRatio = ringDistRatio(ring);
    for (let segment = 0; segment <= angularSegments; segment++) {
      const angle = (segment / angularSegments) * Math.PI * 2;
      const point = surfacePoint(distRatio, angle, 0.02);
      const carve = carveCaveMouth(point.x + island.position.x, point.z + island.position.z, point.y);
      point.y = carve.y;
      mouthCarveDepth.push(carve.carved);
      terrainPositions.push(point.x, point.y, point.z);
    }
  }

  for (let ring = 0; ring < totalRings; ring++) {
    for (let segment = 0; segment < angularSegments; segment++) {
      const a = ring * (angularSegments + 1) + segment;
      const b = a + 1;
      const c = a + angularSegments + 1;
      const d = c + 1;
      terrainIndices.push(a, c, b);
      terrainIndices.push(b, c, d);
    }
  }

  const terrainGeometry = new THREE.BufferGeometry();
  terrainGeometry.setAttribute('position', new THREE.Float32BufferAttribute(terrainPositions, 3));
  terrainGeometry.setIndex(terrainIndices);
  terrainGeometry.computeVertexNormals();

  // Colors are computed after normals: slope (1 - normal.y) drives exposed
  // rock on steep faces while flat ground keeps sand/grass/jungle.
  const terrainNormals = terrainGeometry.getAttribute('normal') as THREE.BufferAttribute;
  const terrainColors: number[] = [];
  // Normalize height by the island's EXPECTED relief (sea plinth → estimated
  // peak) instead of a fixed r*0.18 — the old mask saturated to rock-gray on
  // any mid-tall island, washing every biome to the same monochrome dome.
  const profileForColor = island.profile;
  const seaBase = 5.15 + r * 0.0085;
  const peakEst = Math.max(
    4,
    r * (0.10 + profileForColor.heightProfile * 0.25 + (profileForColor.peakBoost ?? 0) * 0.15),
  );
  // peakEst OVER-estimates relief on twin/secondary-hill styles, so the
  // volcanic scorch + vein gates (which key on the top half of the cone) never
  // fired on low volcanic isles — island 8 rendered as a generic lush dome
  // despite its smoke column. Measure the REAL relief from the vertices we
  // just generated and gate the volcanic identity on that. Deliberately kept
  // separate from `peakEst`: the grass/rock/peak masks are tuned against the
  // estimate and swapping them wholesale re-greys every lush island.
  let realPeakY = -Infinity;
  for (let i = 1; i < terrainPositions.length; i += 3) {
    if (terrainPositions[i] > realPeakY) realPeakY = terrainPositions[i];
  }
  const realRelief = Math.max(4, realPeakY - (5.15 + r * 0.0085));
  // Bright white-sand shelves (atoll/crescent lagoons) sit at ~sea level, so
  // pull their wet/submerged tints hard toward lagoon turquoise — otherwise the
  // barely-emergent floor stays a blinding white plate from above (audit P1).
  const wetSandColor = sandColor.clone().multiplyScalar(0.6).lerp(new THREE.Color(0x2f7d84), whiteSand ? 0.45 : 0.24);
  const submergedColor = new THREE.Color(whiteSand ? 0x2a8a90 : 0x1d4a52);
  // Smooth WORLD-SPACE value noise for organic ground mottling. Keying colour
  // on world XZ (not the ring/segment indices) kills the radial "pinwheel"
  // smear that streaked from every island centre, and gives the flat
  // vertex-colour terrain large- and small-scale variation at eye level.
  const vHash = (ix: number, iz: number): number => {
    const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const vNoise = (x: number, z: number): number => {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = vHash(ix, iz), b = vHash(ix + 1, iz), c = vHash(ix, iz + 1), d = vHash(ix + 1, iz + 1);
    return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
  };
  const groundFbm = (x: number, z: number): number =>
    vNoise(x * 0.045, z * 0.045) * 0.55 + vNoise(x * 0.14, z * 0.14) * 0.3 + vNoise(x * 0.46, z * 0.46) * 0.15;
  // Geyser mouths scorch the ground around them (works on ANY biome — a vent
  // on a grass island still burns a char ring), so the vent geometry sits in
  // ash instead of on untouched turf.
  const ventScorch = (island.geysers ?? []).map((g) => ({
    x: g.x - island.position.x,
    z: g.z - island.position.z,
    r: Math.max(1.5, g.radius) * 3.2,
  }));
  for (let ring = 0; ring <= totalRings; ring++) {
    const distRatio = ringDistRatio(ring);
    for (let segment = 0; segment <= angularSegments; segment++) {
      const index = ring * (angularSegments + 1) + segment;
      const angle = (segment / angularSegments) * Math.PI * 2;
      const coast = getIslandCoastWeights(island, angle);
      const rockyCoast = coast.rocky + coast.cliff;
      const pointY = terrainPositions[index * 3 + 1];
      const slope = THREE.MathUtils.clamp(1 - terrainNormals.getY(index), 0, 1);

      const heightNorm = THREE.MathUtils.clamp((pointY - seaBase) / peakEst, 0, 1);
      /** Same band, measured against the island's ACTUAL relief — used only by
       *  the volcanic ash/vein gates (see realRelief). */
      const reliefNorm = THREE.MathUtils.clamp((pointY - seaBase) / realRelief, 0, 1);
      const shoreMask = THREE.MathUtils.smoothstep(distRatio, 0.72, 0.99);
      // Grass is the DEFAULT interior ground: any land above the waterline is
      // green (the distRatio gate alone keeps a sand berm at the shore), so
      // even low, wide aprons on big islands read lush — not as tan dunes.
      const grassMask = THREE.MathUtils.smoothstep(heightNorm, -0.08, 0.05)
        * (1 - THREE.MathUtils.smoothstep(distRatio, 0.84, 0.99));
      const jungleMask = THREE.MathUtils.smoothstep(heightNorm, 0.08, 0.4)
        * (1 - THREE.MathUtils.smoothstep(distRatio, 0.55, 0.82)) * 0.58;
      // Rock is earned by SLOPE first; only genuinely high ground rock-caps.
      const rockMask = THREE.MathUtils.smoothstep(heightNorm, 0.72, 0.97) * (1 - shoreMask * 0.6) * 0.55;
      const peakMask = THREE.MathUtils.smoothstep(heightNorm, 0.88, 1) * 0.4;
      const mudMask = THREE.MathUtils.smoothstep(distRatio, 0.62, 0.78) * (1 - shoreMask) * 0.14;
      // Rock is earned on genuinely STEEP faces (~50°+). The old 0.26 start
      // painted grey rock over every gently-sloped dome flank, washing lush
      // islands to a muddy monochrome; grass now holds the walkable slopes.
      const slopeRockMask = THREE.MathUtils.smoothstep(slope, 0.42, 0.74) * (1 - shoreMask);

      terrainColor.copy(sandColor);
      terrainColor.lerp(beachColor, shoreMask * coast.beach * 0.95);
      terrainColor.lerp(cliffColor, shoreMask * rockyCoast * 0.75);
      terrainColor.lerp(mudColor, mudMask);
      terrainColor.lerp(grassColor, grassMask);
      terrainColor.lerp(jungleColor, jungleMask);
      terrainColor.lerp(cliffColor, rockMask);
      terrainColor.lerp(rockSlopeColor, slopeRockMask * 0.72);
      // Mountains bare craggy grey stone across their upper flanks (not just the
      // steepest faces) so the peak reads as rock — the same stone the cave mouth
      // is carved from — instead of a smooth green dome.
      if (isMountainColor) {
        const craggy = THREE.MathUtils.smoothstep(heightNorm, 0.4, 0.8) * (1 - shoreMask);
        terrainColor.lerp(rockSlopeColor, craggy * 0.55 * (1 - grassMask * 0.4));
        // Mottle the exposed rock (darken crevices, lift facets) on world-space
        // noise so the massif reads as fractured stone, not flat monochrome.
        const mwx = terrainPositions[index * 3 + 0] + island.position.x;
        const mwz = terrainPositions[index * 3 + 2] + island.position.z;
        terrainColor.multiplyScalar(1 + craggy * (groundFbm(mwx, mwz) - 0.5) * 0.55);
      }
      terrainColor.lerp(peakColor, peakMask * (1 - slopeRockMask));
      // Cave-mouth cut faces (and passage-skimming shelves, sentinel 0.35)
      // are freshly exposed ROCK, not turf: without this the trench and the
      // shelves crossing the arch keep their grass/sand height-band colors
      // and the opening reads as green slabs floating in the hillside.
      const cutDepth = mouthCarveDepth[index] ?? 0;
      if (cutDepth > 0.3) {
        terrainColor.lerp(rockSlopeColor, Math.max(0.78, Math.min(1, cutDepth / 1.6)) * 0.9);
      }
      scratchColor.copy(beachColor).multiplyScalar(THREE.MathUtils.smoothstep(distRatio, 0.9, 1) * 0.14);
      terrainColor.add(scratchColor);

      // Waterline gradient on the new shore rings: dry sand → darker wet
      // sand at the lapping band → blue-green submerged slope, so the
      // beach visually walks into the sea.
      // Waves lap above mean sea level, so start wetting/submerging sand a bit
      // ABOVE y=0: a barely-submerged shelf (e.g. the atoll lagoon floor) then
      // reads as turquoise shallow water, not a blinding white sand plate.
      const wetMask = THREE.MathUtils.smoothstep(-pointY, -1.1, 0.35);
      const depthMask = THREE.MathUtils.smoothstep(-pointY, -0.5, 1.8);
      if (wetMask > 0) {
        terrainColor.lerp(wetSandColor, wetMask * (0.6 + coast.beach * 0.3));
        terrainColor.lerp(submergedColor, depthMask * 0.9);
      }
      // whiteSand archipelago/crescent lagoons sit as emergent bright-sand
      // flats AT sea level (above water, so the depth tint never engages) that
      // read as a blinding white plate from above. Tint the low, non-berm
      // interior toward lagoon aqua so it reads as the shallow water it should.
      if (whiteSand) {
        const lagoon = (1 - THREE.MathUtils.smoothstep(heightNorm, 0.0, 0.13)) * (1 - shoreMask * 0.55);
        terrainColor.lerp(new THREE.Color(0x54b8bd), lagoon * 0.55);
      }

      // ── Volcanic: char the cone to ash; the magma CRACK FIELD itself is
      // evaluated per-pixel in the fragment shader (a per-vertex field on
      // 4-8m vertices smeared every hairline vein into a ~10m glow bar).
      // Here we only store the smooth GATE that says "how molten is this
      // region", which interpolates cleanly.
      let magmaGate = 0;
      let summitGlow = 0;
      let ashAmount = 0;
      if (isVolcanic) {
        // Veins run across the whole upper cone — a volcano's flanks are ALL
        // slope, so don't suppress by steepness; just keep them off the beach.
        magmaGate = THREE.MathUtils.smoothstep(reliefNorm, 0.14, 0.66) * (1 - shoreMask);
        // Just the very tip glows molten (the caldera itself), painted into the
        // terrain so the crater reads as part of the peak — not a floating disc.
        summitGlow = THREE.MathUtils.smoothstep(reliefNorm, 0.9, 0.995) * 0.55 * (1 - shoreMask);
        // Scorch the high ground to ashen charcoal so the thin veins glow against
        // dark rock. Every volcanic island now earns a basalt/ash floor down to
        // the shore band, not just the one tall cone.
        const scorch = THREE.MathUtils.smoothstep(reliefNorm, 0.05, 0.45) * (1 - shoreMask);
        const basalt = (1 - shoreMask) * 0.32;              // dark volcanic soil everywhere inland
        // Capped below 1: at a full lerp the ground goes flat near-black and
        // the whole biome palette (and the ash grain) disappears.
        ashAmount = Math.min(0.86, scorch * 0.95 + basalt);
        terrainColor.lerp(ashCharcoal, ashAmount);
      }
      // Vent char ring (any biome): ash halo so the geyser rim reads as burnt.
      if (ventScorch.length) {
        const lx = terrainPositions[index * 3 + 0];
        const lz = terrainPositions[index * 3 + 2];
        let burn = 0;
        for (const v of ventScorch) {
          const d = Math.hypot(lx - v.x, lz - v.z);
          burn = Math.max(burn, 1 - THREE.MathUtils.smoothstep(d, v.r * 0.35, v.r));
        }
        if (burn > 0.01) {
          terrainColor.lerp(ashCharcoal, burn * 0.85);
          ashAmount = Math.max(ashAmount, burn);
        }
      }
      terrainMagma.push(magmaGate);
      terrainSummit.push(summitGlow);

      // ── Snow line: the summit of a tall mountain whitens (terrain-hugging,
      // heavier on flatter shelves where snow settles, thinner on sheer faces). ──
      if (isSnowy) {
        // Snow keyed on ABSOLUTE height above the sea (not heightNorm, whose
        // peakEst over-estimated relief so the band never triggered) — the top
        // third of a real spire whitens, heavier on flatter shelves.
        const snow = THREE.MathUtils.smoothstep(pointY, seaBase + 34, seaBase + 50)
          * (1 - shoreMask)
          * (1 - slopeRockMask * 0.65);
        if (snow > 0) terrainColor.lerp(snowColor, Math.min(1, snow * 0.85));
      }

      // Per-vertex noise + a low-frequency hue drift so large faces never
      // read as one flat paint bucket (survives ACES tonemapping). Sand
      // (near shore) gets extra tonal variation so beaches don't clip to a
      // uniform bright halo.
      const sandiness = shoreMask * coast.beach;
      const worldX = terrainPositions[index * 3 + 0] + island.position.x;
      const worldZ = terrainPositions[index * 3 + 2] + island.position.z;
      // World-space fbm: broad tonal drift + finer mottle, plus a hint of
      // per-vertex grain. Warm the brighter patches, cool the darker ones.
      const fbm = groundFbm(worldX, worldZ) - 0.5;                       // -0.5..0.5
      const grain = (rng(ring * 113 + segment * 17) - 0.5) * (0.05 + sandiness * 0.05);
      const bright = 1 + fbm * 0.26 + grain;
      const warm = fbm * 0.05;
      terrainColors.push(
        THREE.MathUtils.clamp(terrainColor.r * bright + warm, 0, 1),
        THREE.MathUtils.clamp(terrainColor.g * bright, 0, 1),
        THREE.MathUtils.clamp(terrainColor.b * bright - warm * 0.6, 0, 1),
      );

      // ── Fragment-detail material class (0 sand / 1 grass / 2 rock / 3 ash).
      // Weighted average rather than an argmax so a beach→grass boundary
      // crossfades its GRAIN too, not just its colour.
      const wSand = 0.35 + sandiness * 1.6 + shoreMask * 0.5;
      const wGrass = grassMask * 2.2 + jungleMask * 1.2;
      const wRock = slopeRockMask * 2.4 + rockMask * 1.6 + shoreMask * rockyCoast * 1.4
        + (cutDepth > 0.3 ? 2.5 : 0)
        + (isMountainColor ? THREE.MathUtils.smoothstep(heightNorm, 0.4, 0.8) * 1.6 : 0);
      const wAsh = ashAmount * 3.2;
      const wSum = wSand + wGrass + wRock + wAsh;
      terrainMatClass.push(wSum > 0.0001 ? (wGrass + wRock * 2 + wAsh * 3) / wSum : 1);
    }
  }
  terrainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(terrainColors, 3));

  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, side: THREE.DoubleSide });
  terrainGeometry.setAttribute('aMat', new THREE.Float32BufferAttribute(terrainMatClass, 1));
  if (isVolcanic) {
    terrainGeometry.setAttribute('aMagma', new THREE.Float32BufferAttribute(terrainMagma, 1));
    terrainGeometry.setAttribute('aSummit', new THREE.Float32BufferAttribute(terrainSummit, 1));
  }
  applyTerrainDetail(terrainMat, isVolcanic, host);
  const terrain = new THREE.Mesh(terrainGeometry, terrainMat);
  terrain.name = 'island-terrain';
  // The DoubleSide heightfield casting onto ITSELF produced a heavy self-shadow
  // acne wash that crushed every island to murky olive. Let the terrain receive
  // shadows (props/trees/ships ground onto it) but not cast — a single-dome
  // island barely shadows itself anyway, and this restores lush sunlit ground.
  terrain.castShadow = false;
  terrain.receiveShadow = true;
  group.add(terrain);

  // Underwater plinth: the terrain cap itself now follows the heightfield
  // below the waterline (shore rings above), so this skirt is fully
  // submerged — it just closes the volume from the mesh's underwater edge
  // down to the reef base so islands never read as floating shells.
  const skirtPositions: number[] = [];
  const skirtColors: number[] = [];
  const skirtIndices: number[] = [];
  const skirtSegments = lowDetail ? 26 : visualDetail < 0.85 ? 34 : 44;
  const skirtBottomColor = new THREE.Color(0x28414b);
  const skirtTopColor = new THREE.Color(0x2c545c);
  for (let segment = 0; segment <= skirtSegments; segment++) {
    const angle = (segment / skirtSegments) * Math.PI * 2;
    const top = surfacePoint(1 + shoreRingSpan - 0.005, angle, -0.04);
    const expand = 1.018 + (rng(segment * 313 + 11) - 0.5) * 0.02;
    const bottomY = -Math.max(4.5, r * 0.16) - rng(segment * 317 + 17) * Math.max(0.5, r * 0.022);
    skirtPositions.push(top.x, top.y, top.z);
    skirtPositions.push(top.x * expand, bottomY, top.z * expand);

    skirtColors.push(skirtTopColor.r, skirtTopColor.g, skirtTopColor.b);
    skirtColors.push(skirtBottomColor.r, skirtBottomColor.g, skirtBottomColor.b);
  }
  for (let segment = 0; segment < skirtSegments; segment++) {
    const a = segment * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    skirtIndices.push(a, b, c);
    skirtIndices.push(c, b, d);
  }
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute('position', new THREE.Float32BufferAttribute(skirtPositions, 3));
  skirtGeometry.setAttribute('color', new THREE.Float32BufferAttribute(skirtColors, 3));
  skirtGeometry.setIndex(skirtIndices);
  skirtGeometry.computeVertexNormals();
  const shoreSkirt = new THREE.Mesh(
    skirtGeometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
  );
  shoreSkirt.name = 'island-shore-skirt';
  shoreSkirt.castShadow = true;
  shoreSkirt.receiveShadow = true;
  group.add(shoreSkirt);

  return { seaBase, peakEst, shoreRingSpan, rockSlopeColor, wetSandColor, submergedColor };
}

/** Proxy LOD = a genuine low-res sample of the same shared heightfield with the
 *  same biome coloring, so distant islands keep their true silhouette, coast
 *  shape, and palette — no pop, no monochrome domes. */
export function buildProxyTerrainMesh(ctx: IslandBuildCtx, terrain: TerrainBuild): THREE.Mesh {
  const { island, surfacePoint, sandColor, beachColor, cliffColor, grassColor, peakColor } = ctx;
  const { shoreRingSpan, seaBase, peakEst, rockSlopeColor, wetSandColor, submergedColor } = terrain;
  const pRad = 10;
  const pAng = 30;
  const pShore = 2;
  const pTotal = pRad + pShore;
  const pRingDist = (ring: number): number => ring <= pRad
    ? (ring === 0 ? 0 : Math.pow(ring / pRad, 0.9))
    : 1 + ((ring - pRad) / pShore) * shoreRingSpan;
  const pPos: number[] = [];
  const pIdx: number[] = [];
  const pCol: number[] = [];
  for (let ring = 0; ring <= pTotal; ring++) {
    const dRatio = pRingDist(ring);
    for (let seg = 0; seg <= pAng; seg++) {
      const angle = (seg / pAng) * Math.PI * 2;
      const point = surfacePoint(dRatio, angle, 0.02);
      pPos.push(point.x, point.y, point.z);
    }
  }
  for (let ring = 0; ring < pTotal; ring++) {
    for (let seg = 0; seg < pAng; seg++) {
      const a = ring * (pAng + 1) + seg;
      const b = a + 1;
      const c = a + pAng + 1;
      const d = c + 1;
      pIdx.push(a, c, b, b, c, d);
    }
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
  pGeo.setIndex(pIdx);
  pGeo.computeVertexNormals();
  const pNorm = pGeo.getAttribute('normal') as THREE.BufferAttribute;
  const pColor = new THREE.Color();
  for (let ring = 0; ring <= pTotal; ring++) {
    const dRatio = pRingDist(ring);
    for (let seg = 0; seg <= pAng; seg++) {
      const index = ring * (pAng + 1) + seg;
      const angle = (seg / pAng) * Math.PI * 2;
      const coast = getIslandCoastWeights(island, angle);
      const pointY = pPos[index * 3 + 1];
      const slope = THREE.MathUtils.clamp(1 - pNorm.getY(index), 0, 1);
      const heightNorm = THREE.MathUtils.clamp((pointY - seaBase) / peakEst, 0, 1);
      const shoreMask = THREE.MathUtils.smoothstep(dRatio, 0.72, 0.99);
      pColor.copy(sandColor);
      pColor.lerp(beachColor, shoreMask * coast.beach * 0.95);
      pColor.lerp(cliffColor, shoreMask * (coast.rocky + coast.cliff) * 0.75);
      pColor.lerp(grassColor, THREE.MathUtils.smoothstep(heightNorm, 0.02, 0.42) * (1 - shoreMask));
      pColor.lerp(rockSlopeColor, THREE.MathUtils.smoothstep(slope, 0.26, 0.6) * (1 - shoreMask) * 0.85);
      pColor.lerp(peakColor, THREE.MathUtils.smoothstep(heightNorm, 0.88, 1) * 0.4);
      const wet = THREE.MathUtils.smoothstep(-pointY, -0.55, 0.25);
      if (wet > 0) {
        pColor.lerp(wetSandColor, wet * 0.6);
        pColor.lerp(submergedColor, THREE.MathUtils.smoothstep(-pointY, 0.2, 2.6) * 0.8);
      }
      pCol.push(pColor.r, pColor.g, pColor.b);
    }
  }
  pGeo.setAttribute('color', new THREE.Float32BufferAttribute(pCol, 3));
  const proxyMesh = new THREE.Mesh(
    pGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98 }),
  );

  return proxyMesh;
}
