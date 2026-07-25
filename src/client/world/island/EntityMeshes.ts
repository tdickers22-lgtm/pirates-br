/**
 * The island's interactable furniture: treasure chests (and their buried
 * mounds), supply barrels, and the ship-upgrade stations with their anvil, sign
 * and gated glow. Each one registers its meshes in the Game-side record maps so
 * the per-frame sync can find them again.
 *
 * These hang off the environment root rather than the island group — they're
 * replicated entities whose transforms the server owns.
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import { makeUpgradeSignTexture } from '../../rendering/factories/TextureFactory.js';
import { makeUpgradeStationProp } from '../../rendering/factories/MiscMeshFactory.js';
import type { IslandBuildCtx } from './context.js';
import { buildPropInstance } from './PropScatterer.js';

export function buildChestMeshes(ctx: IslandBuildCtx) {
  const { host, island, lowDetail } = ctx;
  for (const chest of island.chests) {
    const chestGroup = new THREE.Group();
    chestGroup.position.set(chest.position.x, chest.position.y, chest.position.z);

    const surfaceY = getIslandSurfaceY(island, chest.position.x, chest.position.z);

    let chestMesh: THREE.Object3D;
    let lid: THREE.Object3D;
    const chestGlb = buildPropInstance(
      'chest_closed',
      new THREE.Vector3(0, -0.42, 0),
      (chest.position.x * 7.13 + chest.position.z * 3.71) % (Math.PI * 2),
      1.15,
    );
    if (chestGlb) {
      chestGroup.add(chestGlb);
      chestMesh = chestGlb;
      lid = new THREE.Group(); // GLB includes the lid; keep the record shape for syncChests
      chestGroup.add(lid);
    } else {
      const chestBox = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.7, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.95 }),
      );
      chestBox.castShadow = true;
      chestGroup.add(chestBox);
      chestMesh = chestBox;

      const lidMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.08, 0.2, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x8b5e2f, roughness: 0.9 }),
      );
      lidMesh.position.y = 0.42;
      chestGroup.add(lidMesh);
      lid = lidMesh;
    }

    const glow = new THREE.PointLight(0xffc75a, 1.2, 12);
    glow.position.set(0, 1.2, 0);
    glow.visible = false; // gated to ~55m by updateEnvironmentLod (light budget)
    chestGroup.userData.decorLight = lowDetail ? null : glow;
    chestGroup.add(glow);

    let mound: THREE.Mesh | null = null;
    if (chest.buried) {
      mound = new THREE.Mesh(
        new THREE.ConeGeometry(1.05, 0.52, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a3c26, roughness: 1 }),
      );
      mound.position.set(0, surfaceY - chest.position.y + 0.1, 0);
      mound.castShadow = true;
      chestGroup.add(mound);
      chestMesh.visible = false;
      lid.visible = false;
      glow.intensity = 0.4;
      glow.position.set(0, surfaceY - chest.position.y + 0.85, 0);
    }

    host.environment.add(chestGroup);
    host.chestMeshes.set(chest.id, { root: chestGroup, glow, chestMesh, lid, mound });
  }
}

export function buildBarrelMeshes(ctx: IslandBuildCtx) {
  const { host, island } = ctx;
  for (const barrel of island.barrels) {
    const barrelRoot = new THREE.Group();
    barrelRoot.position.set(barrel.position.x, barrel.position.y, barrel.position.z);
    const barrelGlb = buildPropInstance(
      'barrel',
      new THREE.Vector3(0, 0, 0),
      (barrel.position.x * 5.31 + barrel.position.z * 2.17) % (Math.PI * 2),
      0.88,
    );
    if (barrelGlb) {
      barrelRoot.add(barrelGlb);
    } else {
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3010, roughness: 0.95 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.72, 10), woodMat);
      body.position.y = 0.36;
      body.castShadow = true;
      barrelRoot.add(body);
      const lidB = new THREE.Mesh(
        new THREE.CylinderGeometry(0.36, 0.36, 0.06, 10),
        new THREE.MeshStandardMaterial({ color: 0x2a4a6a, roughness: 0.85 }),
      );
      lidB.position.y = 0.78;
      barrelRoot.add(lidB);
    }
    host.environment.add(barrelRoot);
    host.barrelMeshes.set(barrel.id, barrelRoot);
  }
}

export function buildUpgradeStationMeshes(ctx: IslandBuildCtx) {
  const { host, island, lowDetail } = ctx;
  for (const station of island.upgradeStations) {
    const meta = host.getUpgradePresentation(station.type);
    const stationGroup = new THREE.Group();
    stationGroup.position.set(station.position.x, station.position.y - 0.24, station.position.z);

    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6d6558, roughness: 1 });
    const sootMat = new THREE.MeshStandardMaterial({ color: 0x2b2723, roughness: 1 });

    const groundPad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.08, 1.24, 0.22, 9),
      stoneMat,
    );
    groundPad.position.y = -0.08;
    groundPad.castShadow = true;
    groundPad.receiveShadow = true;
    stationGroup.add(groundPad);

    const firePit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.48, 0.56, 0.14, 8),
      sootMat,
    );
    firePit.position.y = 0.06;
    firePit.castShadow = true;
    firePit.receiveShadow = true;
    stationGroup.add(firePit);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.94, 0.28, 7),
      new THREE.MeshStandardMaterial({ color: 0x4b3b28, roughness: 0.96 }),
    );
    base.position.y = 0.14;
    base.castShadow = true;
    base.receiveShadow = true;
    stationGroup.add(base);

    const anvilBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.34, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x2f333d, roughness: 0.62, metalness: 0.58 }),
    );
    anvilBase.position.y = 0.46;
    anvilBase.castShadow = true;
    stationGroup.add(anvilBase);

    const anvilTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.12, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x4b5262, roughness: 0.42, metalness: 0.75 }),
    );
    anvilTop.position.set(0.08, 0.68, 0);
    anvilTop.castShadow = true;
    stationGroup.add(anvilTop);

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18, 0),
      new THREE.MeshStandardMaterial({
        color: meta.hex,
        emissive: meta.hex,
        emissiveIntensity: 0.85,
        roughness: 0.28,
        metalness: 0.2,
      }),
    );
    core.position.set(0, 0.96, 0);
    core.castShadow = true;
    stationGroup.add(core);

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.38, 0.035, 6, 24),
      new THREE.MeshBasicMaterial({
        color: meta.hex,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    halo.rotation.x = Math.PI * 0.5;
    halo.position.y = 0.72;
    stationGroup.add(halo);

    const light = new THREE.PointLight(meta.hex, 2.2, 16);
    light.position.set(0, 1.06, 0);
    light.visible = false; // gated to ~55m by updateEnvironmentLod (light budget)
    stationGroup.userData.decorLight = lowDetail ? null : light;
    stationGroup.add(light);

    const stationProp = makeUpgradeStationProp(station.type, meta.hex);
    stationGroup.add(stationProp);

    const signTitle = station.type === 'hull_reinforcement'
      ? 'Hull Armor'
      : station.type === 'charged_cannons'
        ? 'Cannons'
        : 'Sail Speed';
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.05, 0.76),
      new THREE.MeshBasicMaterial({
        map: makeUpgradeSignTexture(signTitle, meta.effect, meta.hex),
        transparent: true,
        opacity: 0.94,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    sign.position.set(0, 1.86, 0);
    sign.renderOrder = 6;
    stationGroup.add(sign);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x4d321c, roughness: 0.92 });
    for (const x of [-0.78, 0.78]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.32, 7), postMat);
      post.position.set(x, 1.05, -0.04);
      post.castShadow = true;
      stationGroup.add(post);
    }

    for (let rock = 0; rock < 5; rock++) {
      const angle = (rock / 5) * Math.PI * 2 + 0.28;
      const radius = 0.86 + (rock % 2) * 0.12;
      const stone = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.16 + (rock % 2) * 0.05, 0),
        stoneMat,
      );
      stone.position.set(Math.cos(angle) * radius, 0.02, Math.sin(angle) * radius);
      stone.scale.set(1.2, 0.8, 1);
      stone.castShadow = true;
      stone.receiveShadow = true;
      stationGroup.add(stone);
    }

    host.environment.add(stationGroup);
    host.upgradeStationMeshes.set(station.id, {
      root: stationGroup,
      core,
      halo,
      sign,
      light,
      type: station.type,
    });
  }
}
