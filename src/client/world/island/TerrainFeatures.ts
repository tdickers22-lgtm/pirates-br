/**
 * What the land itself grew: sedimentary strata bands, the offshore reef ring,
 * jagged rock spires, the cloud collar on a tall summit, and the odd flat
 * terrace ledge. (Cascades moved out to island/WaterfallBuilder — a fall is now
 * a whole composition of rock, water and mist, not a ribbon.)
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import type { IslandBuildCtx } from './context.js';
import { ensureMeshGround } from './GroundTruth.js';

/** Layered cliff strata — exposed rock bands wrapping high cliffs. (Skipped on
 *  mountains: the sheer spires changed the slopes those slabs were sampled
 *  against, leaving them floating mid-air.) */
export function buildCliffStrata(ctx: IslandBuildCtx) {
  const { island, group, rng, lowDetail, surfacePoint, isSolidDecorPoint, SURFACE_ABOVE_WATER, scaledCount } = ctx;
  if (island.profile.heightProfile > 0.35 && !lowDetail && island.profile.terrainStyle !== 'mountain') {
    const strataMats = [
      new THREE.MeshStandardMaterial({ color: 0x6a5d48, roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x564b3a, roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x46402f, roughness: 1, flatShading: true }),
    ];
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
        slab.position.y += h01 * 0.4;
        slab.rotation.set(
          (rng(band * 751 + s) - 0.5) * 0.18,
          angle + Math.PI * 0.5 + (rng(band * 753 + s) - 0.5) * 0.3,
          (rng(band * 757 + s) - 0.5) * 0.16,
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
  const { island, group, rng, surfacePoint, isSolidDecorPoint, SURFACE_ABOVE_WATER, scaledCount, boulderGeo } = ctx;
  if (island.profile.terrainStyle === 'mountain' || island.profile.terrainStyle === 'rocky') {
    const spireMat = new THREE.MeshStandardMaterial({ color: 0x6a5f52, roughness: 1, flatShading: true });
    const spireCount = scaledCount(island.profile.terrainStyle === 'mountain' ? 4 : 3, 2);
    for (let i = 0; i < spireCount; i++) {
      const angle = island.profile.ridgeAxis + (i / spireCount) * Math.PI + rng(i * 503 + 13) * 0.6;
      const distRatio = 0.32 + rng(i * 509 + 17) * 0.4;
      const surface = surfacePoint(distRatio, angle);
      if (!isSolidDecorPoint(surface, SURFACE_ABOVE_WATER, -0.2)) continue;
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
      const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x3e342a, roughness: 1 });
      for (let s = 0; s < 4; s++) {
        const sa = (s / 4) * Math.PI * 2 + rng(i * 543 + s) * 0.5;
        const rOff = spireR * (0.85 + rng(i * 549 + s) * 0.35);
        const rx = surface.x + Math.cos(sa) * rOff;
        const rz = surface.z + Math.sin(sa) * rOff;
        const ry = getIslandSurfaceY(island, rx + island.position.x, rz + island.position.z);
        const rock = new THREE.Mesh(boulderGeo, rubbleMat);
        rock.scale.setScalar(0.35 + rng(i * 551 + s) * 0.32);
        rock.position.set(rx, ry + 0.18, rz);
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
        const subSurfY = getIslandSurfaceY(island, surface.x + offX + island.position.x, surface.z + offZ + island.position.z);
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

/** Peak mist — tall summits wear a slow ring of cloud (SoT reference). */
export function buildPeakMist(ctx: IslandBuildCtx) {
  const { island, group, rng, lowDetail } = ctx;
  {
    const profileMist = island.profile;
    const peakLocalX = Math.cos(profileMist.primaryHillAngle) * profileMist.primaryHillOffset * profileMist.footprintX;
    const peakLocalZ = Math.sin(profileMist.primaryHillAngle) * profileMist.primaryHillOffset * profileMist.footprintZ;
    const peakY = getIslandSurfaceY(island, island.position.x + peakLocalX, island.position.z + peakLocalZ);
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
      for (let m = 0; m < 6; m++) {
        const mistSprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: mistTex,
          transparent: true,
          opacity: 0.4 + rng(m * 977) * 0.2,
          depthWrite: false,
        }));
        const ma = (m / 6) * Math.PI * 2 + rng(m * 983) * 0.8;
        const mr = 7 + rng(m * 991) * 9;
        mistSprite.position.set(
          peakLocalX + Math.cos(ma) * mr,
          peakY - 4 - rng(m * 997) * 5,
          peakLocalZ + Math.sin(ma) * mr,
        );
        const ms = 9 + rng(m * 1009) * 8;
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
    const terraceMat = new THREE.MeshStandardMaterial({ color: 0xa48d62, roughness: 0.98 });
    const terraceCount = r > 58 ? 3 : 2;
    for (let i = 0; i < terraceCount; i++) {
      const angle = island.profile.ridgeAxis + (i - 1) * 0.46 + (rng(i * 1103 + islandSeed) - 0.5) * 0.18;
      const pos = surfacePoint(0.34 + i * 0.08 + rng(i * 1109 + islandSeed) * 0.06, angle, 0.035);
      if (pos.y < 1.4 || !isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) continue;
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
