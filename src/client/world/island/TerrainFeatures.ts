/**
 * What the land itself grew: cascades off the cliff lips, sedimentary strata
 * bands, the offshore reef ring, jagged rock spires, the cloud collar on a tall
 * summit, and the odd flat terrace ledge.
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import type { IslandBuildCtx } from './context.js';

/** Every tall island earns cascades (SoT reference: white ribbons pouring off
 *  the rock with mist at the base). Mountains get two falls on opposite
 *  shoulders; tall plateaus one. */
export function buildWaterfalls(ctx: IslandBuildCtx) {
  const { host, island, group, rng, lowDetail, surfacePoint, seatDecor, islandSeed } = ctx;
  const fallCount = island.profile.terrainStyle === 'mountain' ? 2
    : (island.profile.terrainStyle === 'plateau' || island.profile.terrainStyle === 'twin') ? 1
      : 0;
  for (let fall = 0; fall < fallCount; fall++) {
    const fallAngle = island.profile.ridgeAxis
      + Math.PI * (fall === 0 ? 0.5 : -0.55)
      + (rng(islandSeed * 47 + fall * 131) - 0.5) * 0.4;
    // Find the STEEPEST short segment along this heading (a real cliff lip) so
    // the ribbon hangs ~vertically off it. The old fixed 0.3→0.94 span was a
    // 30m+ mostly-horizontal reach that drew the fall as a flat white bar lying
    // across the island (worst on low plateaus).
    // AUDIT REGRESSION (floating-props P1): zero waterfalls existed scene-wide.
    // The old scan started at d=0.32 with a steepness ratio of 0.6, but the
    // post-relief mountain spires are steepest NEAR THE PEAK (small distRatio)
    // and their grade rarely exceeds 0.45 over a 0.12 span. Consciously
    // loosened: scan from d=0.06 and accept ratio > 0.32, keeping the drop>4
    // gate below so only a genuine cascade spawns. Also sweeps a few headings
    // around the nominal angle and keeps the best — one fixed bearing could
    // land on the island's gentle flank and find nothing.
    let lip = surfacePoint(0.3, fallAngle);
    let toe = surfacePoint(0.42, fallAngle);
    // Two passes: take a genuinely sheer face if one exists, and only fall
    // back to the loosened threshold when the island has none (otherwise a
    // 20-degree grass slope wins the search and the "cascade" is a stream).
    for (const minRatio of [0.75, 0.32]) {
      let bestScore = -1;
      for (let a = -3; a <= 3; a++) {
        const scanAngle = fallAngle + a * 0.16;
        for (let d = 0.06; d <= 0.86; d += 0.04) {
          const hi = surfacePoint(d, scanAngle);
          const lo = surfacePoint(d + 0.12, scanAngle);
          const dr = hi.y - lo.y;
          const horiz = Math.hypot(lo.x - hi.x, lo.z - hi.z);
          const ratio = dr / Math.max(0.1, horiz);
          const score = dr * ratio;
          if (ratio > minRatio && score > bestScore) { bestScore = score; lip = hi; toe = lo; }
        }
      }
      if (bestScore > 0 && lip.y - toe.y > 4) break;
    }
    // The sheet falls vertically from the lip, landing near the cliff base
    // (only a little outward), so it reads as a plunging cascade.
    const upper = lip;
    const lower = {
      x: lip.x + (toe.x - lip.x) * 0.35,
      y: toe.y,
      z: lip.z + (toe.z - lip.z) * 0.35,
    };
    const drop = upper.y - lower.y;
    if (drop > 4) {
      const fallMat = new THREE.MeshStandardMaterial({
        color: 0xc7e6f4,
        emissive: 0xb8e0f5,
        emissiveIntensity: 0.06, // falls catch the sky, they don't self-glow at night
        roughness: 0.4,
        transparent: true,
        opacity: 0.62,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      // Ribbons that HUG the rock face: at each height step, march outward
      // along the fall heading until the terrain drops below that height, and
      // stand the sheet a few centimetres proud of the face. A single flat
      // quad from lip to toe hangs in open air whenever the face is concave.
      const ribbons = lowDetail ? 2 : 3;
      const vSteps = lowDetail ? 5 : 10;
      const dxFall = lower.x - upper.x;
      const dzFall = lower.z - upper.z;
      const horizFall = Math.hypot(dxFall, dzFall);
      const dirX = horizFall > 0.001 ? dxFall / horizFall : 1;
      const dirZ = horizFall > 0.001 ? dzFall / horizFall : 0;
      const wAxisX = -dirZ;
      const wAxisZ = dirX;
      /** Horizontal reach at which the rock face has fallen to height `y`.
       *  Finely marched and MONOTONIC — a coarse march made the sheet
       *  zig-zag across the slope in visible sawtooth steps. */
      const marchSteps = 48;
      const maxS = Math.max(6, horizFall * 2.4);
      const profileY: number[] = [];
      for (let k = 0; k <= marchSteps; k++) {
        const cand = (k / marchSteps) * maxS;
        profileY.push(getIslandSurfaceY(
          island,
          upper.x + dirX * cand + island.position.x,
          upper.z + dirZ * cand + island.position.z,
        ));
      }
      const faceReach = (y: number): number => {
        for (let k = 1; k <= marchSteps; k++) {
          if (profileY[k] <= y) {
            const span = Math.max(1e-4, profileY[k - 1] - profileY[k]);
            const frac = THREE.MathUtils.clamp((profileY[k - 1] - y) / span, 0, 1);
            return ((k - 1 + frac) / marchSteps) * maxS;
          }
        }
        return maxS;
      };
      const toeReach = faceReach(lower.y);
      // All ribbons of one fall live in a single geometry — 4 separate meshes
      // per cascade was 4 draw calls for one visual object.
      const corners: number[] = [];
      const idx: number[] = [];
      for (let rib = 0; rib < ribbons; rib++) {
        const t = rib / Math.max(1, ribbons - 1);
        const lateral = (t - 0.5) * 3.6;
        const ribbonW = 1.0 + rng(rib * 711) * 0.55;
        const ribBase = corners.length / 3;
        for (let v = 0; v <= vSteps; v++) {
          const f = v / vSteps;
          const y = upper.y - drop * f;
          // Stand the sheet on the rock FACE, lifted clear of it: the sheet
          // sits at the horizontal reach where the ground is at height `y`,
          // then floats 0.7m above that. On a sheer face faceReach() barely
          // moves with height, so the sheet is vertical (a plunging cascade);
          // on a graded face it becomes a chute hugging the slope. Dropping
          // straight down from the lip instead buried 80% of the sheet inside
          // the hill on every non-overhanging face (seen in verification).
          const reach = faceReach(y) + 0.35;
          const cx = upper.x + dirX * reach + wAxisX * lateral;
          const cz = upper.z + dirZ * reach + wAxisZ * lateral;
          const sheetY = y + 0.45;
          // Width wobbles down the drop so the chute reads as moving water
          // rather than a straight-edged plastic strip.
          const wob = 1 + Math.sin(f * 7.5 + rib * 2.1) * 0.22 + Math.sin(f * 17.0 + rib) * 0.1;
          const halfW = ribbonW * (0.6 + f * 0.4) * wob * 0.5;   // widens as it falls
          corners.push(cx + wAxisX * halfW, sheetY, cz + wAxisZ * halfW);
          corners.push(cx - wAxisX * halfW, sheetY, cz - wAxisZ * halfW);
          if (v > 0) {
            const a0 = ribBase + (v - 1) * 2;
            idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
          }
        }
      }
      {
        const ribbonGeo = new THREE.BufferGeometry();
        ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
        ribbonGeo.setIndex(idx);
        ribbonGeo.computeVertexNormals();
        const ribbon = new THREE.Mesh(ribbonGeo, fallMat);
        ribbon.name = 'waterfall-ribbon';
        group.add(ribbon);
      }
      // Plunge pool where the sheet lands (lit, NOT self-glowing: a Basic
      // material renders full white at midnight and made the pool a lamp).
      const poolReach = toeReach + 1.2;
      const poolX = upper.x + dirX * poolReach;
      const poolZ = upper.z + dirZ * poolReach;
      const poolY = getIslandSurfaceY(island, poolX + island.position.x, poolZ + island.position.z);
      const poolSeat = seatDecor(poolX, poolZ, 1.6, 0.5);
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(1.5, 18),
        new THREE.MeshStandardMaterial({
          color: 0xdff1f8, roughness: 0.2, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      // Lie the pool ON the slope: a flat disc dropped on a hillside cuts a
      // hard white ellipse half-buried in the rock.
      pool.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), poolSeat.normal);
      pool.position.set(poolX, poolY + 0.07, poolZ);
      pool.renderOrder = 2;
      group.add(pool);
      // Mist billowing off the plunge point.
      if (!lowDetail) {
        // Soft alpha sprites, not shaded spheres: overlapping low-poly balls
        // stacked their alpha into hard white blobs at the fall's base.
        const mistCount = 14;
        const mistPos = new Float32Array(mistCount * 3);
        for (let m = 0; m < mistCount; m++) {
          mistPos[m * 3] = poolX + (rng(m * 717) - 0.5) * 3.0;
          mistPos[m * 3 + 1] = poolY + 0.3 + rng(m * 721) * 2.6;
          mistPos[m * 3 + 2] = poolZ + (rng(m * 723) - 0.5) * 3.0;
        }
        const mistGeo = new THREE.BufferGeometry();
        mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPos, 3));
        const mist = new THREE.Points(mistGeo, new THREE.PointsMaterial({
          size: 2.6,
          map: host.getSoftParticleTexture(),
          color: 0xccdde5,
          transparent: true,
          opacity: 0.17,
          depthWrite: false,
        }));
        mist.frustumCulled = false;
        group.add(mist);
      }
      lower.x = poolX;
      lower.z = poolZ;
      lower.y = poolY;
      // Add a stream channel — darker dirt strip from base toward the shore
      const streamSteps = 6;
      const streamMat = new THREE.MeshStandardMaterial({ color: 0x4a6478, roughness: 0.6, emissive: 0x224050, emissiveIntensity: 0.2 });
      for (let st = 0; st < streamSteps; st++) {
        const t = st / streamSteps;
        const sx = lower.x + (lower.x * 0.06) * t;
        const sz = lower.z + (lower.z * 0.06) * t;
        const sy = getIslandSurfaceY(island, sx + island.position.x, sz + island.position.z);
        if (sy < 5.2) continue;
        const seg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.8), streamMat);
        seg.position.set(sx, sy + 0.03, sz);
        group.add(seg);
      }
    }
  }
}

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

/** Reef ring — sharp dark rocks just offshore. */
export function buildReefRing(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, scaledCount } = ctx;
  {
    const reefMatDark = new THREE.MeshStandardMaterial({ color: 0x5b5348, roughness: 1 });
    const reefMatWet = new THREE.MeshStandardMaterial({ color: 0x6d6455, roughness: 0.9 });
    const reefCount = scaledCount(Math.round(r / 8), 5);
    const reefGeoSharp = new THREE.ConeGeometry(0.7, 1.2, 5);
    const reefGeoChunk = new THREE.DodecahedronGeometry(0.6, 0);
    for (let i = 0; i < reefCount; i++) {
      const angle = rng(i * 401 + 91) * Math.PI * 2;
      const distRatio = 1.06 + rng(i * 409 + 97) * 0.22;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const fx = cosA * island.radius * distRatio * island.profile.footprintX;
      const fz = sinA * island.radius * distRatio * island.profile.footprintZ;
      const seaY = 0.05;
      const sharp = rng(i * 419) > 0.5;
      const reef = new THREE.Mesh(
        sharp ? reefGeoSharp : reefGeoChunk,
        rng(i * 421) > 0.4 ? reefMatDark : reefMatWet,
      );
      const stickOut = (rng(i * 431) - 0.3) * 1.6; // some submerged, some breaking
      const scale = 0.7 + rng(i * 433) * 1.4;
      reef.scale.set(scale * (0.7 + rng(i * 437) * 0.6), scale * (0.6 + rng(i * 441) * 1.2), scale * (0.7 + rng(i * 443) * 0.6));
      // AUDIT P2: these were pinned to a fixed sea offset regardless of what
      // was (or wasn't) under them, so rocks over a sub-sea shelf hung in mid
      // air above the water with their foam ring painted on the sea below.
      // Seat on the seabed where it's shallow enough to reach, and always
      // keep the base at least ~0.2m under the waterline so nothing floats.
      const reefHalfH = 0.6 * reef.scale.y;   // both source geos are 1.2 tall
      const bedY = getIslandSurfaceY(island, fx + island.position.x, fz + island.position.z);
      const seated = bedY > -0.6 ? bedY + reefHalfH * 0.55 : seaY + stickOut;
      reef.position.set(fx, Math.min(seated, reefHalfH - 0.2), fz);
      reef.rotation.set(rng(i * 447) * 0.6, rng(i * 449) * Math.PI * 2, (rng(i * 451) - 0.5) * 0.6);
      reef.castShadow = false;
      reef.receiveShadow = true;
      group.add(reef);

      // Add a small splash collar of foam (a flat ring sliver) for ones poking above water
      if (reef.position.y + reefHalfH > 0.12 && !lowDetail) {
        const foam = new THREE.Mesh(
          new THREE.RingGeometry(scale * 0.55, scale * 0.95, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
        );
        foam.rotation.x = -Math.PI * 0.5;
        foam.position.set(fx, seaY + 0.01, fz);
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
