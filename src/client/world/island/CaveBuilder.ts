/**
 * Walkable caves: the mouth carved into the hillside, the enclosed rock tube,
 * the throat collar, and the interior dressing (stalactites, torches, crystals,
 * the dead-end treasure). The terrain itself hollows out via `getIslandSurfaceY`;
 * everything that makes the hollow READ as a cave is built here.
 */
import * as THREE from 'three';
import type { Island } from '../../../shared/types/index.js';
import { applyCaveTubeColors, cullCaveTubeAgainstNeighbors, makeCaveTubeGeometry } from '../../rendering/factories/CaveGeometry.js';
import { registerBudgetLight } from '../../rendering/LightBudget.js';
import type { CaveMouthCarve, IslandBuildCtx } from './context.js';

/** Build the island's cave-mouth carve function. The terrain mesh lowers its
 *  vertices through this, and every decor placement checks it so nothing hovers
 *  inside an opening the mesh has been cut away from. */
export function makeCaveMouthCarver(island: Island): (worldX: number, worldZ: number, y: number) => CaveMouthCarve {
  // Carve a real MOUTH into the hillside at each cave entrance so it reads as a
  // gaping hole you walk into — not a shallow dip in a solid hill. The trench
  // stays open-air ONLY while the natural hillside can't yet roof the tube
  // (clearance-keyed, not a fixed z-fraction): the old whole-length cut, sized
  // for 1.9m ramps, left 10m+ grass-colored cliff faces knifing through the
  // passage once entrances started plunging to the waterline — walking in put
  // the camera inside terrain backfaces. Past the throat the tunnel keeps its
  // natural rock roof and the interior arched tube encloses the passage.
  // Cave-local frame matches caveGroup.rotation.
  const carveCaveMouth = (worldX: number, worldZ: number, y: number): { y: number; carved: number } => {
    if (!island.caves) return { y, carved: 0 };
    let out = y;
    let carved = 0;
    for (const cave of island.caves) {
      if (!cave.hasMouth) continue; // only real surface mouths open the hillside
      if (out <= cave.floorY) continue;
      const dx = worldX - cave.position.x;
      const dz = worldZ - cave.position.z;
      const cs = Math.cos(cave.rotation);
      const sn = Math.sin(cave.rotation);
      const lx = dx * cs - dz * sn;      // lateral
      const lz = dx * sn + dz * cs;      // +z outward (entrance), tunnel to -z
      const cLen = (cave as { length?: number }).length ?? 10;
      const cR = (cave as { interiorRadius?: number }).interiorRadius ?? 3;
      const fEnd = (cave as { floorYEnd?: number }).floorYEnd ?? cave.floorY;
      const along = cLen > 0 ? Math.min(1, Math.max(0, -lz / cLen)) : 0;
      const floorAt = cave.floorY + (fEnd - cave.floorY) * along;
      const ceilAt = floorAt + cave.height;
      // Any terrain surface skimming the passage volume gets flagged so the
      // color pass paints it CAVE ROCK and decor skips it — near the mouth
      // the natural hillside legitimately crosses the arch's upper region
      // (the tube pokes out of the hill until the roof builds), and those
      // shelves must not read as floating grass.
      const inStrip = Math.abs(lx) < cR * 1.6 && lz < 1.2 && lz > -cLen - 1;
      if (inStrip && out < ceilAt + 1.2) carved = Math.max(carved, 0.35);
      // Gully walls fade OUTSIDE the tube's wobbliest wall radius (~1.5·cR) so
      // partially-carved vertices land on the open-air cut sides, never inside.
      const latK = THREE.MathUtils.smoothstep(Math.abs(lx), cR * 1.5, cR * 1.5 + 1.9);
      // Approach gully outward of the mouth plane (fades by lz≈4.4).
      const outerK = THREE.MathUtils.smoothstep(lz, 1.6, 4.4);
      // DOORWAY-ONLY cut: open the sky above just the first ~2.6m. The
      // carved→natural transition wall this creates is short (natural ground
      // sits barely above the arch this close to the mouth), lands above head
      // height, and is wrapped by the rock collar — it reads as the doorway's
      // inner lintel. The cut MUST be a smooth function of (lz, lx) only:
      // an earlier per-vertex "already roofed → skip" gate made neighbouring
      // vertices diverge by metres and sliced diagonal faces across the
      // passage (the "green walls inside the cave" screenshot).
      const depthCapK = THREE.MathUtils.smoothstep(-lz, 1.4, 2.6);
      const keep = Math.max(latK, outerK, depthCapK);
      const target = floorAt + (out - floorAt) * keep;
      if (target < out) {
        carved = Math.max(carved, out - target);
        out = target;
      }
    }
    return { y: out, carved };
  };
  return carveCaveMouth;
}

/** Walkable caves — terrain hollows out via getIslandSurfaceY, this adds the
 *  ceiling, side walls, back wall, entrance frame, and a torch so the cavern
 *  reads as a real explorable cave you can step into. */
export function buildCaves(ctx: IslandBuildCtx) {
  const { island, group, rng, lowDetail, isVolcanic, paletteRock, boulderGeo } = ctx;
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
        registerBudgetLight(mouthGlow);
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
        registerBudgetLight(torchLight);
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
            registerBudgetLight(glow);
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
}
