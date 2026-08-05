/**
 * What the land itself grew: sedimentary strata bands, the offshore reef ring,
 * jagged rock spires, the cloud collar on a tall summit, and the odd flat
 * terrace ledge. (Cascades moved out to island/WaterfallBuilder — a fall is now
 * a whole composition of rock, water and mist, not a ribbon.)
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import type { IslandBuildCtx } from './context.js';
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
  const { island, group, rng, lowDetail, surfacePoint, isSolidDecorPoint, SURFACE_ABOVE_WATER, scaledCount, cliffColor } = ctx;
  if (island.profile.heightProfile > 0.35 && !lowDetail && island.profile.terrainStyle !== 'mountain') {
    // These were three hard-coded browns — 0x6a5d48 / 0x564b3a / 0x46402f — the
    // last of which sits at 0.099 luma. On the pale sand of a bone isle that is
    // a black slab lying on a beach, which is exactly what the audit counted,
    // and it was a foreign brown on every OTHER island too: strata are the
    // island's own bedrock, so they take the island's own cliff tone. Three
    // bands stepped down from it keep the layered read without any of them
    // going near the floor.
    const strataMats = [-0.04, -0.18, -0.30].map((step, i) => {
      const c = cliffColor.clone().multiplyScalar(1 + step);
      // Deeper beds run warmer, the way iron-stained rock does.
      c.lerp(new THREE.Color(0x8a6a44), i * 0.11);
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true });
      paintFeatureRock(m, `pirates-strata-${i}`, 0.42);
      return m;
    });
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
        // BURIED, AND CANTED. The slab used to be LIFTED (up to 0.34 m) and
        // laid almost dead level (±0.09 rad): on a cliff band that reads as a
        // ledge, but a bone isle's strata land on near-flat sand, and a level
        // box sitting proud of flat ground is a CRATE — which is what the audit
        // counted them as. Bedding rock does neither: it is mostly under the
        // ground it broke out of, and it lies at the angle the bed was tilted
        // to. So sink it by a third of its own thickness and cant it four times
        // as hard. Nothing here is a collider, so no walk or reach changes.
        //
        // h01 is the band's height up the flank, and it still earns its keep:
        // the high beds are the freshly broken ones and stand out further, the
        // low beds have had the whole hillside washing over them and sit deeper.
        slab.position.y -= slabH * (0.52 - h01 * 0.30);
        slab.rotation.set(
          (rng(band * 751 + s) - 0.5) * 0.66,
          angle + Math.PI * 0.5 + (rng(band * 753 + s) - 0.5) * 0.3,
          (rng(band * 757 + s) - 0.5) * 0.58,
        );
        slab.castShadow = true;
        slab.receiveShadow = true;
        group.add(slab);
      }
    }
  }
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
export function buildReefRing(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, scaledCount } = ctx;
  const ground = ensureMeshGround(ctx);
  {
    const reefMatDark = new THREE.MeshStandardMaterial({ color: 0x5b5348, roughness: 1 });
    const reefMatWet = new THREE.MeshStandardMaterial({ color: 0x6d6455, roughness: 0.9 });
    // Same family, same treatment — a reef cone is the one rock you see from a
    // metre away as the swim carries you past it.
    paintFeatureRock(reefMatDark, 'pirates-reef-dark', 0.22);
    paintFeatureRock(reefMatWet, 'pirates-reef-wet', 0.26);
    const reefCount = scaledCount(Math.round(r / 8), 5);
    const reefGeoSharp = new THREE.ConeGeometry(0.7, 1.2, 5);
    const reefGeoChunk = new THREE.DodecahedronGeometry(0.6, 0);
    const seaY = 0.05;
    /** Drawn seabed under an island-local point, analytic only where the
     *  terrain mesh does not reach (the low-detail proxy path). */
    const bedAt = (lx: number, lz: number): number => ground?.heightAt(lx, lz)
      ?? getIslandSurfaceY(island, lx + island.position.x, lz + island.position.z);
    for (let i = 0; i < reefCount; i++) {
      const angle = rng(i * 401 + 91) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const sharp = rng(i * 419) > 0.5;
      const scale = 0.7 + rng(i * 433) * 1.4;
      const scaleY = scale * (0.6 + rng(i * 441) * 1.2);
      const rockH = 1.2 * scaleY;             // both source geos are 1.2 tall
      const burial = rockH * 0.24;            // sunk, so a tilt never lifts an edge
      // Same spread of tips as before: some rocks awash, some breaking clear.
      const wantTop = seaY + (rng(i * 431) - 0.3) * 1.6;
      const jitter = rng(i * 409 + 97) * 0.03;
      let best: { fx: number; fz: number; bed: number; top: number; err: number } | null = null;
      for (let s = 0; s <= 15; s++) {
        const distRatio = 1.32 + jitter - s * 0.028;
        const fx = cosA * island.radius * distRatio * island.profile.footprintX;
        const fz = sinA * island.radius * distRatio * island.profile.footprintZ;
        const bed = bedAt(fx, fz);
        // Inshore of the waterline is beach, not reef — stop before the ring
        // walks up the sand.
        if (bed > -0.15) break;
        const top = bed + rockH - burial;
        const err = Math.abs(top - wantTop);
        if (best === null || err < best.err) best = { fx, fz, bed, top, err };
        if (top >= wantTop) break;            // shallow enough; no need to go further in
      }
      // Nothing on this bearing the rock could stand on and still be seen.
      if (best === null || best.top < -1.2) continue;
      const reef = new THREE.Mesh(
        sharp ? reefGeoSharp : reefGeoChunk,
        rng(i * 421) > 0.4 ? reefMatDark : reefMatWet,
      );
      // Seat on the LOWEST drawn ground under the footprint so the downhill
      // side of a shelving seabed leaves no daylight either…
      const seat = ground?.seat(best.fx, best.fz, Math.max(0.35, scale * 0.5));
      const bed = seat ? Math.min(seat.lo, seat.center) : best.bed;
      // …and then GROW to the tip the ring wanted, rather than sink below it:
      // seating on the footprint's low corner costs up to a metre of height,
      // and a reef whose rocks all quietly drown is not a reef.
      const grown = Math.min(rockH * 2.2, Math.max(rockH, wantTop - bed + burial));
      reef.scale.set(scale * (0.7 + rng(i * 437) * 0.6), grown / 1.2, scale * (0.7 + rng(i * 443) * 0.6));
      reef.position.set(best.fx, bed - burial + grown * 0.5, best.fz);
      reef.rotation.set(rng(i * 447) * 0.6, rng(i * 449) * Math.PI * 2, (rng(i * 451) - 0.5) * 0.6);
      reef.castShadow = false;
      reef.receiveShadow = true;
      reef.name = 'decor-reef-rock';
      group.add(reef);

      // Add a small splash collar of foam (a flat ring sliver) for ones poking above water
      if (reef.position.y + grown * 0.5 > 0.12 && !lowDetail) {
        const foam = new THREE.Mesh(
          new THREE.RingGeometry(scale * 0.55, scale * 0.95, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
        );
        foam.rotation.x = -Math.PI * 0.5;
        foam.position.set(best.fx, seaY + 0.01, best.fz);
        // Foam floats on the WATER, not on the ground — it is the one piece
        // here the grounding audit must read as sea dressing.
        foam.name = 'reef-foam';
        group.add(foam);
      }
    }
  }
}

/** Sharp rock spires — jagged peaks for mountain/rocky islands. */
export function buildRockSpires(ctx: IslandBuildCtx) {
  const { island, group, rng, surfacePoint, isSolidDecorPoint, SURFACE_ABOVE_WATER, scaledCount, boulderGeo, cliffColor } = ctx;
  // Spires were seated on the analytic heightfield, and a spire cluster is FOUR
  // rubble stones plus a sub-spike around one cone. On convex ground — a caldera
  // rim, a ridge shoulder, which is where the 0.32-0.72 distance band puts them
  // — the drawn mesh chord runs below the function, so the whole cluster lifted
  // off the slope together and photographed as one pale spiky object balanced on
  // the hillside. Everything below seats on the ground it is drawn against.
  const ground = ensureMeshGround(ctx);
  const drawnY = (lx: number, lz: number): number => {
    const y = ground?.heightAt(lx, lz);
    return y === null || y === undefined
      ? getIslandSurfaceY(island, lx + island.position.x, lz + island.position.z)
      : y;
  };
  if (island.profile.terrainStyle === 'mountain' || island.profile.terrainStyle === 'rocky') {
    // Was a hard-coded 0x6a5f52 on a cone up to 13m tall: a black shark fin on
    // the skyline of every rocky isle, and a foreign tone beside the hillside it
    // grows out of. Now the island's own cliff stone, plus bedding, an aspect
    // bleach and a floor it cannot fall below.
    // 0.86, not 1.0: at the hillside's own value a 13m spire dissolves into the
    // slope behind it, which is the opposite failure to the one being fixed. A
    // seventh of a stop down is stone standing on sand.
    const spireMat = new THREE.MeshStandardMaterial({
      color: cliffColor.clone().multiplyScalar(0.86), roughness: 1, flatShading: true,
    });
    paintFeatureRock(spireMat, 'pirates-spire', 0.55);
    // Hoisted out of the per-spire loop: it used to be rebuilt for every spire,
    // which is four materials (and four shader hookups) for one look.
    const rubbleMat = new THREE.MeshStandardMaterial({
      color: cliffColor.clone().multiplyScalar(0.78), roughness: 1,
    });
    paintFeatureRock(rubbleMat, 'pirates-spire-rubble', 0.34);
    const spireCount = scaledCount(island.profile.terrainStyle === 'mountain' ? 4 : 3, 2);
    for (let i = 0; i < spireCount; i++) {
      const angle = island.profile.ridgeAxis + (i / spireCount) * Math.PI + rng(i * 503 + 13) * 0.6;
      const distRatio = 0.32 + rng(i * 509 + 17) * 0.4;
      const surface = surfacePoint(distRatio, angle);
      if (!isSolidDecorPoint(surface, SURFACE_ABOVE_WATER, -0.2)) continue;
      surface.y = drawnY(surface.x, surface.z);
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
      for (let s = 0; s < 4; s++) {
        const sa = (s / 4) * Math.PI * 2 + rng(i * 543 + s) * 0.5;
        const rOff = spireR * (0.85 + rng(i * 549 + s) * 0.35);
        const rx = surface.x + Math.cos(sa) * rOff;
        const rz = surface.z + Math.sin(sa) * rOff;
        const ry = drawnY(rx, rz);
        const rock = new THREE.Mesh(boulderGeo, rubbleMat);
        const rockScale = 0.35 + rng(i * 551 + s) * 0.32;
        rock.scale.setScalar(rockScale);
        // Bitten IN, not balanced on: a dodecahedron whose centre sits a fifth of
        // a metre above the ground shows daylight under it from every downhill
        // angle. Sink it by a third of its own radius instead.
        rock.position.set(rx, ry - rockScale * 0.30, rz);
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
        const subSurfY = drawnY(surface.x + offX, surface.z + offZ);
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
export function buildTerraces(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, islandHeading, SURFACE_ABOVE_WATER } = ctx;
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
}
