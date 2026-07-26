/**
 * What a volcano does to the air around it: ashfall over the whole island,
 * embers off the caldera, the smoke column, and every geyser's vent rim,
 * recessed throat, idle steam and erupting plume.
 *
 * The molten glow itself is painted into the terrain (aMagma / aSummit); these
 * are the moving parts, each registered through `pushVolcanicFx` so one frame
 * loop drives them and culls them by camera distance.
 */
import * as THREE from 'three';
import { geyserEruptionLevel, getIslandSurfaceY } from '../../../shared/utils/index.js';
import { refreshFrozenChild } from '../../rendering/three-util.js';
import type { IslandBuildCtx } from './context.js';

/** Caldera lava, ashfall, embers, smoke and geyser plumes. */
export function buildVolcanicFx(ctx: IslandBuildCtx) {
  const {
    host, island, group, r, rng, lowDetail, visualDetail, seatDecor,
    islandMaxR, footprintX, footprintZ, paletteRock, isVolcanic,
  } = ctx;
  if (isVolcanic) {
    const pulse = host.magmaPulseUniform;
    const particleTex = host.getSoftParticleTexture();
    const islandCenter = new THREE.Vector3(island.position.x, 0, island.position.z);
    const cullRadius = islandMaxR + 440;

    // Caldera / peak position — anchors the smoke plume + ember source. The
    // molten glow of the crater is painted into the summit TERRAIN (aMagma
    // summitGlow above), so there's no flat floating lava disc.
    const peakAngle = island.profile.primaryHillAngle;
    const peakOffset = island.profile.primaryHillOffset;
    const cpx = Math.cos(peakAngle) * peakOffset * footprintX;
    const cpz = Math.sin(peakAngle) * peakOffset * footprintZ;
    const peakY = getIslandSurfaceY(island, cpx + island.position.x, cpz + island.position.z);
    const lavaR = Math.max(2.6, r * 0.055);

    // Ashfall — grey flakes settling over the whole island (drift + wrap).
    const baseAshY = Math.max(6, peakY * 0.4);
    const ashTopY = peakY + 46;
    const ashCount = lowDetail ? 70 : Math.round(200 * visualDetail);
    {
      const pos = new Float32Array(ashCount * 3);
      const spd = new Float32Array(ashCount);
      for (let i = 0; i < ashCount; i++) {
        const a = rng(i * 91) * Math.PI * 2;
        const rad = Math.sqrt(rng(i * 47 + 3)) * islandMaxR * 0.98;
        pos[i * 3] = Math.cos(a) * rad;
        pos[i * 3 + 1] = baseAshY + rng(i * 13 + 7) * (ashTopY - baseAshY);
        pos[i * 3 + 2] = Math.sin(a) * rad;
        spd[i] = 2.2 + rng(i * 29) * 2.4;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ size: 0.5, map: particleTex, color: 0x8f8880, transparent: true, opacity: 0.5, depthWrite: false });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      group.add(points);
      host.pushVolcanicFx((dt, _wt, cam) => {
        const vis = cam.distanceTo(islandCenter) <= cullRadius;
        points.visible = vis;
        if (!vis) return;
        for (let i = 0; i < ashCount; i++) {
          let y = pos[i * 3 + 1] - spd[i] * dt;
          let x = pos[i * 3] + 0.7 * dt;
          let z = pos[i * 3 + 2] + 0.35 * dt;
          if (y < baseAshY) {
            y = ashTopY;
            const a = Math.random() * Math.PI * 2;
            const rad = Math.sqrt(Math.random()) * islandMaxR * 0.98;
            x = Math.cos(a) * rad;
            z = Math.sin(a) * rad;
          }
          pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        }
        geo.attributes.position.needsUpdate = true;
      });
    }

    // Embers rising off the caldera (additive, flicker with the pulse).
    if (!lowDetail) {
      const emberCount = 40;
      const emberTop = peakY + 18;
      const pos = new Float32Array(emberCount * 3);
      const spd = new Float32Array(emberCount);
      for (let i = 0; i < emberCount; i++) {
        const a = rng(i * 71 + 5) * Math.PI * 2;
        const rad = Math.sqrt(rng(i * 53 + 1)) * lavaR * 2.2;
        pos[i * 3] = cpx + Math.cos(a) * rad;
        pos[i * 3 + 1] = peakY + rng(i * 19) * (emberTop - peakY);
        pos[i * 3 + 2] = cpz + Math.sin(a) * rad;
        spd[i] = 3.0 + rng(i * 37) * 3.5;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ size: 0.42, map: particleTex, color: 0xff8b2e, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      group.add(points);
      host.pushVolcanicFx((dt, _wt, cam) => {
        const vis = cam.distanceTo(islandCenter) <= cullRadius;
        points.visible = vis;
        if (!vis) return;
        mat.opacity = 0.55 + 0.4 * pulse.value;
        for (let i = 0; i < emberCount; i++) {
          let y = pos[i * 3 + 1] + spd[i] * dt;
          let x = pos[i * 3] + Math.sin(_wt * 1.7 + i) * 0.6 * dt;
          if (y > emberTop) {
            y = peakY;
            const a = Math.random() * Math.PI * 2;
            const rad = Math.sqrt(Math.random()) * lavaR * 2.2;
            x = cpx + Math.cos(a) * rad;
            pos[i * 3 + 2] = cpz + Math.sin(a) * rad;
          }
          pos[i * 3] = x; pos[i * 3 + 1] = y;
        }
        geo.attributes.position.needsUpdate = true;
      });
    }

    // Smoke column billowing off the caldera (widens as it rises).
    {
      const smokeCount = lowDetail ? 22 : 44;
      const smokeTop = peakY + 60;
      const pos = new Float32Array(smokeCount * 3);
      const ang = new Float32Array(smokeCount);
      const spd = new Float32Array(smokeCount);
      for (let i = 0; i < smokeCount; i++) {
        ang[i] = rng(i * 61 + 9) * Math.PI * 2;
        const y = peakY + rng(i * 23 + 2) * (smokeTop - peakY);
        const hf = (y - peakY) / (smokeTop - peakY);
        const rad = 1.6 + hf * 9;
        pos[i * 3] = cpx + Math.cos(ang[i]) * rad;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = cpz + Math.sin(ang[i]) * rad;
        spd[i] = 2.4 + rng(i * 41) * 2.2;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ size: 6.5, map: particleTex, color: 0x2b2724, transparent: true, opacity: 0.34, depthWrite: false });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      group.add(points);
      host.pushVolcanicFx((dt, _wt, cam) => {
        const vis = cam.distanceTo(islandCenter) <= cullRadius;
        points.visible = vis;
        if (!vis) return;
        for (let i = 0; i < smokeCount; i++) {
          let y = pos[i * 3 + 1] + spd[i] * dt;
          if (y > smokeTop) y = peakY + (y - smokeTop);
          const hf = (y - peakY) / (smokeTop - peakY);
          const rad = 1.6 + hf * 9;
          pos[i * 3] = cpx + Math.cos(ang[i] + _wt * 0.12) * rad;
          pos[i * 3 + 1] = y;
          pos[i * 3 + 2] = cpz + Math.sin(ang[i] + _wt * 0.12) * rad;
        }
        geo.attributes.position.needsUpdate = true;
      });
    }

    // ── Geyser vents + erupting plumes (synced to the server launch) ──
    for (const geyser of island.geysers ?? []) {
      const gx = geyser.x - island.position.x;
      const gz = geyser.z - island.position.z;
      const gy = geyser.y;
      // ── Vent: a real cracked-stone rim around a recessed dark throat ──
      // (was a flat orange RingGeometry decal + emissive disc lying on the
      // grass — the open backlog defect: "geyser vents are painted circles").
      const ventR = Math.max(0.9, geyser.radius);
      const ventRock = new THREE.MeshStandardMaterial({
        color: paletteRock.clone().multiplyScalar(0.42).getHex(), roughness: 1, flatShading: true,
      });
      const rimChunks = lowDetail ? 7 : 11;
      const rimMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), ventRock, rimChunks);
      rimMesh.name = 'geyser-rim';
      const rimM = new THREE.Matrix4();
      const rimP = new THREE.Vector3();
      const rimQ = new THREE.Quaternion();
      const rimE = new THREE.Euler();
      const rimS = new THREE.Vector3();
      for (let c = 0; c < rimChunks; c++) {
        const a = (c / rimChunks) * Math.PI * 2 + rng(c * 61 + 5) * 0.35;
        const rr = ventR * (0.92 + rng(c * 67 + 11) * 0.30);
        const cx = gx + Math.cos(a) * rr;
        const cz = gz + Math.sin(a) * rr;
        const cy = getIslandSurfaceY(island, cx + island.position.x, cz + island.position.z);
        const s = ventR * (0.24 + rng(c * 71 + 3) * 0.24);
        rimS.set(s * (0.8 + rng(c * 73) * 0.7), s * (0.7 + rng(c * 79) * 0.9), s * (0.8 + rng(c * 83) * 0.6));
        // Rim stones lean OUTWARD, as if shouldered up by the vent.
        rimP.set(cx, cy + s * 0.22, cz);
        rimE.set((rng(c * 89) - 0.5) * 0.5, a, 0.22 + rng(c * 97) * 0.3);
        rimQ.setFromEuler(rimE);
        rimMesh.setMatrixAt(c, rimM.compose(rimP, rimQ, rimS));
      }
      rimMesh.instanceMatrix.needsUpdate = true;
      rimMesh.castShadow = !lowDetail;
      rimMesh.receiveShadow = true;
      group.add(rimMesh);
      // Recessed throat: a dark cone sunk into the ground, with a small
      // molten core disc at the bottom — depth instead of a painted circle.
      const throatDepth = Math.max(0.7, ventR * 0.9);
      const throat = new THREE.Mesh(
        new THREE.ConeGeometry(ventR * 0.72, throatDepth, 14, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0x140f0c, roughness: 1, side: THREE.DoubleSide, emissive: 0x3a1204, emissiveIntensity: 0.35,
        }),
      );
      throat.position.set(gx, gy - throatDepth * 0.42, gz);
      group.add(throat);
      const ventCore = new THREE.Mesh(
        new THREE.CircleGeometry(ventR * 0.34, 12),
        new THREE.MeshStandardMaterial({
          color: 0x1a0d06, roughness: 0.85, emissive: 0xff5a18, emissiveIntensity: 1.4,
        }),
      );
      ventCore.rotation.x = -Math.PI * 0.5;
      ventCore.position.set(gx, gy - throatDepth * 0.86, gz);
      group.add(ventCore);
      // Idle steam: a permanent lazy wisp so a dormant vent still reads as
      // ALIVE from a distance (the old vent was invisible when not erupting).
      const idleCount = lowDetail ? 5 : 9;
      const idlePos = new Float32Array(idleCount * 3);
      const idlePhase = new Float32Array(idleCount);
      const idleAng = new Float32Array(idleCount);
      for (let i = 0; i < idleCount; i++) {
        idlePhase[i] = rng(i * 131 + 9);
        idleAng[i] = rng(i * 137 + 13) * Math.PI * 2;
        idlePos[i * 3] = gx; idlePos[i * 3 + 1] = gy; idlePos[i * 3 + 2] = gz;
      }
      const idleGeo = new THREE.BufferGeometry();
      idleGeo.setAttribute('position', new THREE.BufferAttribute(idlePos, 3));
      const idleMat = new THREE.PointsMaterial({
        size: ventR * 1.05, map: particleTex, color: 0xbfcdd2, transparent: true, opacity: 0.17, depthWrite: false,
      });
      const idleSteam = new THREE.Points(idleGeo, idleMat);
      idleSteam.frustumCulled = false;
      group.add(idleSteam);

      // Plume: a steam/water column that rises only while erupting.
      const plumeCount = lowDetail ? 40 : 130;
      const plumeH = Math.max(9, geyser.power * 0.7);
      const pos = new Float32Array(plumeCount * 3);
      const phase = new Float32Array(plumeCount);
      const ang = new Float32Array(plumeCount);
      for (let i = 0; i < plumeCount; i++) {
        phase[i] = rng(i * 17 + 3);
        ang[i] = rng(i * 29 + 7) * Math.PI * 2;
        pos[i * 3] = gx;
        pos[i * 3 + 1] = gy;
        pos[i * 3 + 2] = gz;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ size: 1.35, map: particleTex, color: 0xeaf6fb, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const plume = new THREE.Points(geo, mat);
      plume.frustumCulled = false;
      group.add(plume);
      // Ground splash: a low mist ring that punches out at the base of a jet.
      const splashMat = new THREE.MeshStandardMaterial({
        color: 0xdfeff5, roughness: 1, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      const splash = new THREE.Mesh(new THREE.RingGeometry(ventR * 0.95, ventR * 1.7, 20), splashMat);
      // Lie the splash collar ON the local slope: a horizontal ring on rolling
      // ground sliced through the hill and read as a big white lens.
      const ventSeat = seatDecor(gx, gz, ventR * 1.6, 0.5);
      splash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ventSeat.normal);
      splash.position.set(gx, gy + 0.16, gz);
      splash.renderOrder = 2;
      group.add(splash);
      host.pushVolcanicFx((_dt, wt, cam) => {
        const far = cam.distanceTo(islandCenter) > cullRadius;
        idleSteam.visible = !far;
        if (far) { plume.visible = false; splash.visible = false; return; }
        const level = geyserEruptionLevel(geyser, wt);
        // Idle wisps: always drifting, fading out as the real jet takes over.
        idleMat.opacity = 0.17 * (1 - Math.min(1, level * 2.5));
        for (let i = 0; i < idleCount; i++) {
          const f = (idlePhase[i] + wt * 0.11) % 1;
          idlePos[i * 3] = gx + Math.cos(idleAng[i] + f * 1.6) * ventR * (0.25 + f * 0.9);
          idlePos[i * 3 + 1] = gy + 0.25 + f * (2.6 + ventR);
          idlePos[i * 3 + 2] = gz + Math.sin(idleAng[i] + f * 1.6) * ventR * (0.25 + f * 0.9);
        }
        idleGeo.attributes.position.needsUpdate = true;
        // The island's static roots are frozen out of three's world-matrix walk
        // (freezeStaticSubtree), so these two — the only nodes in here whose
        // TRANSFORM moves — refresh themselves after each write.
        if (level <= 0.01) {
          plume.visible = false;
          splash.visible = false;
          ventCore.scale.setScalar(1);
          refreshFrozenChild(ventCore);
          return;
        }
        plume.visible = true;
        splash.visible = true;
        mat.opacity = 0.85 * level;
        splashMat.opacity = 0.26 * level;
        splash.scale.setScalar(0.7 + level * 0.8);
        ventCore.scale.setScalar(1 + level * 0.4);
        refreshFrozenChild(splash);
        refreshFrozenChild(ventCore);
        const h = plumeH * level;
        for (let i = 0; i < plumeCount; i++) {
          const f = (phase[i] + wt * 0.85) % 1; // rise up the column, looping
          // Tight at the throat, blooming into a mushroom head near the top —
          // a jet, not the old evenly-scattered cloud of fat dots.
          const spread = geyser.radius * (0.12 + Math.pow(f, 2.4) * 1.9);
          pos[i * 3] = gx + Math.cos(ang[i] + f * 2.2) * spread;
          pos[i * 3 + 1] = gy + f * h;
          pos[i * 3 + 2] = gz + Math.sin(ang[i] + f * 2.2) * spread;
        }
        geo.attributes.position.needsUpdate = true;
      });
    }
  }
}
