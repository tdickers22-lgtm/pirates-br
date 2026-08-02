/**
 * The small stuff that gives an island scale: rock outcrops, driftwood, bamboo,
 * the beached wreck, shells and tide pools on the sand, cairns and pebbles,
 * the interior boulder/log/scrub dressing, banana and dead trees, the mossy log
 * and dinghy, hanging vines and treasure stakes.
 *
 * Client decor only — none of it has colliders, and none of it touches the
 * server registry or its RNG.
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import { assets } from '../../assets/AssetLibrary.js';
import type { IslandBuildCtx } from './context.js';
import { ensureMeshGround, seatOnDrawnGround, snapToDrawnGround } from './GroundTruth.js';
import { flushContactShadows, queueContactShadow } from './ContactShadows.js';
import { attachFleckLod } from './InstanceLod.js';

/** Rock outcrops, driftwood logs, bamboo clusters and the beached hull GLB.
 *  (The old client-only boulder/palm scatter is gone: palms and boulders come
 *  from the server prop registry via buildServerProps, so visuals match the
 *  colliders players actually hit.) */
export function buildRockAndDriftDecor(ctx: IslandBuildCtx) {
  const {
    island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint,
    islandSeed, islandHeading, SURFACE_ABOVE_WATER, scaledCount,
    cliffMat, driftwoodMat, bambooMat, bambooGeo, buildPropInstance,
  } = ctx;
  // Decor is placed on the analytic heightfield but LOOKED AT on the terrain
  // mesh; snap every piece onto the drawn ground (see GroundTruth).
  const ground = ensureMeshGround(ctx);

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
    const ocSeat = seatOnDrawnGround(ctx, outcropSample.x, outcropSample.z, 0.5 * ocScale, { bite: 0.1 });
    outcrop.position.set(outcropSample.x, ocSeat.y + ocH * 0.22, outcropSample.z);
    outcrop.rotation.set(rng(i * 67) * 0.2, rng(i * 71) * Math.PI * 2, (rng(i * 73) - 0.5) * 0.28);
    outcrop.scale.setScalar(ocScale);
    outcrop.castShadow = true;
    outcrop.receiveShadow = true;
    outcrop.name = 'decor-outcrop';
    queueContactShadow(ctx, outcropSample.x, outcropSample.z, 0.5 * ocScale, 0.85);
    group.add(outcrop);
  }

  const driftwoodCount = lowDetail ? 0 : 3 + Math.floor(rng(islandSeed) * 3);
  for (let i = 0; i < driftwoodCount; i++) {
    const angle = rng(i * 223 + 7) * Math.PI * 2;
    const distRatio = 0.76 + rng(i * 229) * 0.16;
    const logPos = surfacePoint(distRatio, angle, 0.04);
    if (!isSolidDecorPoint(logPos, SURFACE_ABOVE_WATER, -0.2)) continue;
    snapToDrawnGround(ground, logPos, 0.02);
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
    log.name = 'decor-driftwood';
    queueContactShadow(ctx, logPos.x, logPos.z, logLen * 0.34, 0.8);
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
      queueContactShadow(ctx, clusterCenter.x, clusterCenter.z, 1.15, 0.45);
      const stalkCount = 3 + Math.floor(rng(g * 263) * 3);
      for (let b = 0; b < stalkCount; b++) {
        const bh = 3.2 + rng(g * 269 + b) * 2.8;
        const bamboo = new THREE.Mesh(bambooGeo, bambooMat);
        // AUDIT P2: every stalk in a cluster shared the CENTRE's ground height,
        // so on a slope the outer stalks hung 0.3-0.6m in the air with their
        // bases cut off. Seat each stalk on its own sample (sunk 0.15m).
        const bx = clusterCenter.x + (rng(b * 271 + g) - 0.5) * 1.4;
        const bz = clusterCenter.z + (rng(b * 277 + g) - 0.5) * 1.4;
        const by = (ground?.heightAt(bx, bz)
          ?? getIslandSurfaceY(island, bx + island.position.x, bz + island.position.z)) - 0.15;
        bamboo.position.set(bx, bh * 0.5 + by, bz);
        bamboo.name = 'decor-bamboo';
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
      ? buildPropInstance(
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
      // Half-beached by design: seat the keel on the drawn sand, not the
      // analytic one, or the hull hangs over the wet-sand chord.
      wreckGlb.position.y = snapToDrawnGround(ground, wreckPos.clone(), -0.15).y;
      wreckGlb.name = 'decor-beached-wreck';
      group.add(wreckGlb);
    }
  }
}

/** Beach detail: shells, starfish, seaweed clumps, tide pools. */
export function buildBeachDecor(ctx: IslandBuildCtx) {
  const { group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, scaledCount, boulderGeo, boulderMat } = ctx;
  const ground = ensureMeshGround(ctx);
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
      snapToDrawnGround(ground, pos, 0.02);
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
        snapToDrawnGround(ground, pos, 0);
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
          const seat = seatOnDrawnGround(ctx, rx, rz, rockScale * 0.9, { bite: 0 });
          rock.position.set(rx, seat.y + rockScale * 0.45, rz);
          rock.rotation.set(rng(r2 * 691) * Math.PI, rng(r2 * 693) * Math.PI, rng(r2 * 697) * Math.PI);
          rock.name = 'decor-poolrock';
          group.add(rock);
        }
      }
    }
  }
}

/** Rock cairns scattered along higher ground. */
export function buildCairns(ctx: IslandBuildCtx) {
  const { group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, scaledCount, boulderGeo, boulderMat } = ctx;
  if (!lowDetail) {
    const cairnCount = scaledCount(2 + Math.round(r / 50), 1);
    for (let i = 0; i < cairnCount; i++) {
      const angle = rng(i * 311 + 17) * Math.PI * 2;
      const distRatio = 0.3 + rng(i * 313 + 19) * 0.3;
      const base = surfacePoint(distRatio, angle, 0);
      if (base.y < 5.6 || !isSolidDecorPoint(base, 5.6, -0.2)) continue;
      const cairn = new THREE.Group();
      cairn.name = 'decor-cairn';
      const cairnSeat = seatOnDrawnGround(ctx, base.x, base.z, 0.4, { bite: 0.16 });
      cairn.position.set(base.x, cairnSeat.y, base.z);
      queueContactShadow(ctx, base.x, base.z, 0.62, 0.85);
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
}

/** Pebbles + rock chips: one InstancedMesh of ankle-height stones. The ground
 *  had NOTHING between 8m props and painted colour; a scatter of sub-20cm stones
 *  gives the eye real scale reference at 2m. Zero colliders, one draw call,
 *  culled with the rest of the island group. */
export function buildPebbles(ctx: IslandBuildCtx) {
  const { group, r, rng, lowDetail, visualDetail, surfacePoint, isSolidDecorPoint, paletteRock } = ctx;
  const ground = ensureMeshGround(ctx);
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
      pPos.set(p.x, (ground?.heightAt(p.x, p.z) ?? p.y) - s * 0.35, p.z);
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
      pebbles.name = 'island-pebbles';
      // …and thinned to nothing by ~190m. A 0.2m stone is 0.54 reference pixels
      // at 300m, and the whole point of the scatter is scale reference at two
      // metres; carrying it to the detail radius cost 7-11k triangles on every
      // island in frame. See island/InstanceLod's FLECK ramp.
      attachFleckLod(pebbles);
      group.add(pebbles);
    }
  }
}

/** Interior dressing: the biggest islands read as empty green domes with a
 *  handful of props on them (audit: Castaway Reach / Rumrunner Key / Gallows
 *  Sands mids). Fill the dead band between the shore ring and the peak with
 *  boulder clusters, fallen trunks and low scrub beds. */
export function buildInteriorDressing(ctx: IslandBuildCtx) {
  const {
    island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint,
    scaledCount, boulderGeo, boulderMat, applyFoliageSway,
  } = ctx;
  const ground = ensureMeshGround(ctx);
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
          const seat = seatOnDrawnGround(ctx, base.x + ox, base.z + oz, sc, { capSink: 0.6, bite: 0 });
          xfPos.set(base.x + ox, seat.y - sc * 0.34, base.z + oz);
          queueContactShadow(ctx, base.x + ox, base.z + oz, sc * 0.78, 0.9);
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
        const seat = seatOnDrawnGround(ctx, base.x, base.z, trunkScale * 1.2, { capSink: 0.5, bite: 0 });
        const logY = seat.y;
        queueContactShadow(ctx, base.x, base.z, trunkScale * 0.85, 0.85);
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
          const gy = ground?.heightAt(base.x + ox, base.z + oz)
            ?? getIslandSurfaceY(island, base.x + ox + island.position.x, base.z + oz + island.position.z);
          xfPos.set(base.x + ox, gy - 0.08, base.z + oz);
          queueContactShadow(ctx, base.x + ox, base.z + oz, sc * 0.62, 0.45);
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
      stoneInst.name = 'decor-interior-stones';
      group.add(stoneInst);
    }
    if (logXf.length && logAsset) {
      const logInst = new THREE.InstancedMesh(logAsset.geometry, logAsset.material, logXf.length);
      logXf.forEach((m, k) => logInst.setMatrixAt(k, m));
      logInst.instanceMatrix.needsUpdate = true;
      logInst.castShadow = true;
      logInst.receiveShadow = true;
      logInst.name = 'decor-interior-logs';
      group.add(logInst);
    }
    if (bushXf.length && bushAsset) {
      applyFoliageSway(bushAsset.material);
      const bushInst = new THREE.InstancedMesh(bushAsset.geometry, bushAsset.material, bushXf.length);
      bushXf.forEach((m, k) => bushInst.setMatrixAt(k, m));
      bushInst.instanceMatrix.needsUpdate = true;
      bushInst.castShadow = false;
      bushInst.receiveShadow = true;
      bushInst.name = 'decor-interior-scrub';
      group.add(bushInst);
    }
  }
}

/** Banana trees, dead bone-grey snags, the mossy fallen log and the beached
 *  dinghy in the dunes. */
export function buildTreesAndStrays(ctx: IslandBuildCtx) {
  const {
    island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint,
    islandSeed, islandHeading, SURFACE_ABOVE_WATER, scaledCount,
  } = ctx;
  const ground = ensureMeshGround(ctx);
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
      tree.name = 'decor-banana-tree';
      tree.position.copy(snapToDrawnGround(ground, pos, -0.08));
      queueContactShadow(ctx, pos.x, pos.z, 1.05, 0.6);
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
      tree.name = 'decor-dead-snag';
      tree.position.copy(snapToDrawnGround(ground, pos, -0.12));
      queueContactShadow(ctx, pos.x, pos.z, 0.72, 0.75);
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
    log.name = 'decor-mossy-log';
    log.position.copy(snapToDrawnGround(ground, pos, -0.1));
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
    if (isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) {
      queueContactShadow(ctx, pos.x, pos.z, length * 0.42, 0.85);
      group.add(log);
    }
  }

  // ── Beached dinghy — small wrecked rowboat in the dunes ──
  if (!lowDetail && r > 40) {
    const dinghyAngle = islandHeading + Math.PI * (rng(islandSeed * 217) > 0.5 ? 0.4 : -0.4);
    const pos = surfacePoint(0.86 + rng(islandSeed * 223) * 0.06, dinghyAngle, 0);
    const dinghy = new THREE.Group();
    dinghy.name = 'decor-dinghy';
    dinghy.position.copy(snapToDrawnGround(ground, pos, -0.06));
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
    if (isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.15)) {
      queueContactShadow(ctx, pos.x, pos.z, 1.35, 0.8);
      group.add(dinghy);
    }
  }
}

/** Hanging vines off the high cliffs, and the crossed-stake treasure markers
 *  (visual decoration, separate from the gameplay chests). */
export function buildVinesAndStakes(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, SURFACE_ABOVE_WATER, scaledCount } = ctx;
  const ground = ensureMeshGround(ctx);
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
      vine.name = 'cliff-vine';
      vine.position.set(top.x + Math.cos(va) * 0.4, top.y - vineLen * 0.5 + 0.1, top.z + Math.sin(va) * 0.4);
      vine.rotation.y = va + Math.PI * 0.5;
      vine.rotation.z = (rng(i * 957) - 0.5) * 0.18;
      group.add(vine);
      // Leaves along the vine
      for (let l = 0; l < 4; l++) {
        const lt = (l + 0.5) / 4;
        const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.18), vineMat);
        leaf.name = 'cliff-vine-leaf';
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
      stake.name = 'decor-stake';
      stake.position.copy(snapToDrawnGround(ground, sp, -0.05));
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

  // LAST client decor pass on the island: every piece that wanted a contact
  // shadow has asked by now, so bake them into the island's single instanced
  // decal mesh. Unconditional — a low-detail island queues nothing and this
  // just clears the (empty) queue.
  flushContactShadows(ctx);
}
