import * as THREE from 'three';
import { ECONOMY, PHYSICS, PLAYER, SHIP, SHIP_STATS, STORM_PHASES, WEAPONS, WORLD } from '../../shared/constants/index.js';
import type {
  GameState, InteractIntent, Island, IslandNpc, ItemStack, Player, Projectile, Ship, ShipKeg, ShipUpgradeType, TradeSession, TreasureChest, UpgradeStation, WeaponId, WeaponInstance,
} from '../../shared/types/index.js';
import { getIslandSurfacePoint, getIslandSurfaceY, getNearestShipBoardingLadder, getIslandDockSwimLadderPoint, isPointInsideIslandFootprint, sampleWind, angleWrap, getMainMastLocalZ, getCrowNestLadderInteractionBounds, getSailStationLocal, gerstnerHeight, WAVE_PARAMS } from '../../shared/utils/index.js';
import { Renderer } from '../rendering/Renderer.js';
import { OceanRenderer } from '../rendering/OceanRenderer.js';
import { ShipRenderer } from '../rendering/ShipRenderer.js';
import { CombatFx } from '../rendering/CombatFx.js';
import { NetworkClient } from '../network/NetworkClient.js';
import { InputManager } from '../input/InputManager.js';

type ChestMeshRecord = {
  root: THREE.Group;
  glow: THREE.PointLight;
  chestMesh: THREE.Mesh;
  lid: THREE.Mesh;
  mound: THREE.Mesh | null;
};

type KegMeshRecord = {
  root: THREE.Group;
  fuse: THREE.PointLight;
};

type UpgradeStationMeshRecord = {
  root: THREE.Group;
  core: THREE.Mesh;
  halo: THREE.Mesh;
  sign: THREE.Mesh;
  light: THREE.PointLight;
  type: ShipUpgradeType;
};

type NpcMeshRecord = {
  root: THREE.Group;
  body: THREE.Group;
  light: THREE.PointLight;
  baseY: number;
  role: IslandNpc['role'];
};

type StoryCutsceneRefs = {
  root: HTMLDivElement;
  title: HTMLDivElement;
  name: HTMLDivElement;
  line: HTMLDivElement;
  cue: HTMLDivElement;
};

type WindWispRecord = {
  mesh: THREE.Mesh;
  radius: number;
  height: number;
  phase: number;
  speed: number;
  sway: number;
  tilt: number;
};

type FloatingDamageIndicator = {
  element: HTMLDivElement;
  worldPos: THREE.Vector3;
  life: number;
  duration: number;
  riseSpeed: number;
};

type UiRefs = {
  loadingScreen: HTMLDivElement;
  loadingBar: HTMLDivElement;
  loadingText: HTMLDivElement;
  compassTape: HTMLDivElement;
  stormPhase: HTMLDivElement;
  stormTimer: HTMLDivElement;
  stormWarning: HTMLDivElement;
  shipsAlive: HTMLDivElement;
  goldAmount: HTMLDivElement;
  healthFill: HTMLDivElement;
  armorFill: HTMLDivElement;
  hullBow: HTMLDivElement;
  hullStern: HTMLDivElement;
  hullPort: HTMLDivElement;
  hullStarboard: HTMLDivElement;
  hullBowTxt: HTMLSpanElement;
  hullSternTxt: HTMLSpanElement;
  hullPortTxt: HTMLSpanElement;
  hullStarboardTxt: HTMLSpanElement;
  sailStatus: HTMLDivElement;
  shipUpgrades: HTMLDivElement;
  ammoCurrent: HTMLSpanElement;
  ammoReserve: HTMLSpanElement;
  reloadIndicator: HTMLDivElement;
  weaponSlots: HTMLDivElement[];
  inventoryWood: HTMLSpanElement;
  inventoryCannonball: HTMLSpanElement;
  inventoryFirebomb: HTMLSpanElement;
  inventoryChainshot: HTMLSpanElement;
  inventoryBanana: HTMLSpanElement;
  shipInventory: HTMLDivElement;
  kegStatus: HTMLDivElement;
  kegStatusValue: HTMLDivElement;
  interactPrompt: HTMLDivElement;
  contextLabel: HTMLDivElement;
  crosshair: HTMLDivElement;
  hitMarker: HTMLDivElement;
  damageIndicatorLayer: HTMLDivElement;
  scopeOverlay: HTMLDivElement;
  killFeed: HTMLDivElement;
  damageVignette: HTMLDivElement;
  knockbackFlash: HTMLDivElement;
  tradeUi: HTMLDivElement;
  yourTradeItems: HTMLDivElement;
  theirTradeItems: HTMLDivElement;
  tradeConfirm: HTMLButtonElement;
  tradeCancel: HTMLButtonElement;
  tradeTimer: HTMLDivElement;
  deathScreen: HTMLDivElement;
  deathStats: HTMLDivElement;
  winScreen: HTMLDivElement;
  winStats: HTMLDivElement;
  minimapCanvas: HTMLCanvasElement;
  mapOverlay: HTMLDivElement;
  mapCanvas: HTMLCanvasElement;
  mapSubtitle: HTMLDivElement;
  islandBanner: HTMLDivElement;
  pocketWheel: HTMLDivElement;
  pocketWheelStats: HTMLDivElement;
  pocketStrip: HTMLDivElement;
  treasureChart: HTMLDivElement;
  treasureChartCanvas: HTMLCanvasElement;
  treasureChartIsland: HTMLDivElement;
  treasureChartRoute: HTMLDivElement;
};

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return element as T;
}

function makePlayerMesh(
  color: number,
  variant: 'pirate' | 'skeleton' = 'pirate',
  role: 'captain' | 'crew' | 'raider' = 'crew',
): THREE.Group {
  const group = new THREE.Group();
  const isSkeleton = variant === 'skeleton';
  const isCaptain = role === 'captain';

  const boneMat = new THREE.MeshStandardMaterial({
    color: 0xe5dfd2,
    roughness: 0.9,
    emissive: 0x8091a7,
    emissiveIntensity: 0.08,
  });
  const boneDarkMat = new THREE.MeshStandardMaterial({ color: 0xb9b09c, roughness: 0.96 });
  const socketMat = new THREE.MeshStandardMaterial({
    color: 0x24303a,
    roughness: 1,
    emissive: 0x76c7ff,
    emissiveIntensity: 0.18,
  });
  const pirateSkinMat = new THREE.MeshStandardMaterial({ color: 0xd4a070, roughness: 0.98 });
  const coatMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xd9d3c4 : color, roughness: 0.92 });
  const clothMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xcfc8b8 : 0xe7dfcf, roughness: 0.96 });
  const skinMat = isSkeleton ? boneMat : pirateSkinMat;
  const darkMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xb5ac98 : 0x2a2019, roughness: 1 });
  const beltMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xc9c0ab : 0x6f4a1f, roughness: 1 });

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.46 : 0.62, 0.82, isSkeleton ? 0.24 : 0.34),
    coatMat,
  );
  torso.castShadow = true;
  torso.position.set(0, 1.28, 0);
  torso.name = 'torso';
  torso.visible = !isSkeleton;
  group.add(torso);

  const shirt = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.2 : 0.34, 0.54, isSkeleton ? 0.2 : 0.36),
    clothMat,
  );
  shirt.castShadow = true;
  shirt.position.set(0, 1.24, 0.02);
  shirt.name = 'shirt';
  shirt.visible = !isSkeleton;
  group.add(shirt);

  const pelvis = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.32 : 0.52, 0.26, isSkeleton ? 0.18 : 0.28),
    beltMat,
  );
  pelvis.castShadow = true;
  pelvis.position.set(0, 0.8, 0);
  pelvis.name = 'pelvis';
  pelvis.visible = !isSkeleton;
  group.add(pelvis);

  const coatSkirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.4, 0.52, 7, 1, true),
    coatMat,
  );
  coatSkirt.position.set(0, 0.66, 0);
  coatSkirt.castShadow = true;
  coatSkirt.name = 'coat-skirt';
  coatSkirt.visible = !isSkeleton;
  group.add(coatSkirt);

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-0.42, 1.54, 0);
  leftArmPivot.name = 'left-arm-pivot';
  const leftArm = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.055 : 0.085, isSkeleton ? 0.072 : 0.1, 0.76, 7),
    isSkeleton ? boneDarkMat : coatMat,
  );
  leftArm.castShadow = true;
  leftArm.position.y = -0.3;
  leftArm.name = 'left-arm';
  leftArmPivot.add(leftArm);
  const leftHand = new THREE.Mesh(
    new THREE.SphereGeometry(isSkeleton ? 0.07 : 0.085, 10, 8),
    skinMat,
  );
  leftHand.castShadow = true;
  leftHand.position.y = -0.7;
  leftHand.name = 'left-hand';
  leftArmPivot.add(leftHand);
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(0.42, 1.54, 0);
  rightArmPivot.name = 'right-arm-pivot';
  const rightArm = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.055 : 0.085, isSkeleton ? 0.072 : 0.1, 0.76, 7),
    isSkeleton ? boneDarkMat : coatMat,
  );
  rightArm.castShadow = true;
  rightArm.position.y = -0.3;
  rightArm.name = 'right-arm';
  rightArmPivot.add(rightArm);
  const rightHand = new THREE.Mesh(
    new THREE.SphereGeometry(isSkeleton ? 0.07 : 0.085, 10, 8),
    skinMat,
  );
  rightHand.castShadow = true;
  rightHand.position.y = -0.7;
  rightHand.name = 'right-hand';
  rightArmPivot.add(rightHand);
  group.add(rightArmPivot);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-0.16, 0.72, 0);
  leftLegPivot.name = 'left-leg-pivot';
  const leftLeg = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.06 : 0.1, isSkeleton ? 0.075 : 0.11, 0.86, 8),
    darkMat,
  );
  leftLeg.castShadow = true;
  leftLeg.position.y = -0.38;
  leftLeg.name = 'left-leg';
  leftLegPivot.add(leftLeg);
  const leftBoot = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.12 : 0.16, 0.18, isSkeleton ? 0.22 : 0.34),
    darkMat,
  );
  leftBoot.castShadow = true;
  leftBoot.position.set(0, -0.82, 0.08);
  leftBoot.name = 'left-boot';
  leftBoot.visible = !isSkeleton;
  leftLegPivot.add(leftBoot);
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(0.16, 0.72, 0);
  rightLegPivot.name = 'right-leg-pivot';
  const rightLeg = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.06 : 0.1, isSkeleton ? 0.075 : 0.11, 0.86, 8),
    darkMat,
  );
  rightLeg.castShadow = true;
  rightLeg.position.y = -0.38;
  rightLeg.name = 'right-leg';
  rightLegPivot.add(rightLeg);
  const rightBoot = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.12 : 0.16, 0.18, isSkeleton ? 0.22 : 0.34),
    darkMat,
  );
  rightBoot.castShadow = true;
  rightBoot.position.set(0, -0.82, 0.08);
  rightBoot.name = 'right-boot';
  rightBoot.visible = !isSkeleton;
  rightLegPivot.add(rightBoot);
  group.add(rightLegPivot);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.23, 18, 14),
    skinMat,
  );
  head.castShadow = true;
  head.position.y = 1.92;
  head.name = 'head';
  if (isSkeleton) {
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.18), boneDarkMat);
    jaw.position.set(0, -0.15, 0.03);
    head.add(jaw);

    const noseCavity = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 3), socketMat);
    noseCavity.position.set(0, -0.03, 0.2);
    noseCavity.rotation.x = Math.PI * 0.52;
    head.add(noseCavity);

    for (const side of [-1, 1] as const) {
      const socket = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), socketMat);
      socket.position.set(side * 0.09, 0.03, 0.17);
      socket.scale.z = 0.8;
      head.add(socket);
    }
  }
  group.add(head);

  if (isSkeleton) {
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.56, 6), boneDarkMat);
    spine.position.set(0, 1.22, -0.02);
    spine.castShadow = true;
    group.add(spine);

    const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.38, 0.12), boneMat);
    sternum.position.set(0, 1.28, 0.04);
    sternum.castShadow = true;
    group.add(sternum);

    for (const side of [-1, 1] as const) {
      for (let rib = 0; rib < 3; rib++) {
        const ribMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.017, 0.02, 0.3 + rib * 0.03, 5),
          boneDarkMat,
        );
        ribMesh.position.set(side * (0.11 + rib * 0.03), 1.4 - rib * 0.14, 0.05 + rib * 0.01);
        ribMesh.rotation.z = side * (Math.PI * 0.34 + rib * 0.05);
        ribMesh.rotation.x = Math.PI * 0.28;
        ribMesh.castShadow = true;
        group.add(ribMesh);
      }
    }
    const hipBone = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.08, 0.12), boneDarkMat);
    hipBone.position.set(0, 0.8, 0.02);
    hipBone.castShadow = true;
    group.add(hipBone);
  }

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.235, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
    darkMat,
  );
  hair.castShadow = true;
  hair.position.y = 2.0;
  hair.name = 'hair';
  hair.visible = !isSkeleton;
  group.add(hair);

  if (!isSkeleton && isCaptain) {
    const hat = new THREE.Group();
    hat.name = 'hat';
    hat.position.set(0, 0.08, 0);

    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.42, 0.05, 18),
      new THREE.MeshStandardMaterial({ color: 0x1d1410, roughness: 0.95 }),
    );
    brim.castShadow = true;
    hat.add(brim);

    const crown = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.2, 0.22, 14),
      new THREE.MeshStandardMaterial({ color: 0x2b1b15, roughness: 0.92 }),
    );
    crown.position.y = 0.12;
    crown.castShadow = true;
    hat.add(crown);

    const feather = new THREE.Mesh(
      new THREE.PlaneGeometry(0.1, 0.34),
      new THREE.MeshStandardMaterial({ color: 0xc7e0f0, roughness: 0.8, side: THREE.DoubleSide }),
    );
    feather.position.set(-0.13, 0.24, 0.04);
    feather.rotation.set(0.28, 0.32, 0.42);
    feather.castShadow = true;
    hat.add(feather);
    head.add(hat);

    const beard = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.22, 8),
      new THREE.MeshStandardMaterial({ color: 0x33231c, roughness: 0.96 }),
    );
    beard.position.set(0, -0.2, 0.04);
    beard.rotation.x = Math.PI;
    beard.castShadow = true;
    head.add(beard);

    const moustache = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.03, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x2b1d18, roughness: 0.96 }),
    );
    moustache.position.set(0, -0.04, 0.2);
    moustache.castShadow = true;
    head.add(moustache);
  }

  const bandana = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.04, 6, 18),
    new THREE.MeshStandardMaterial({ color: role === 'raider' ? 0x2c4f7f : 0x8f2f25, roughness: 0.9 }),
  );
  bandana.rotation.x = Math.PI * 0.5;
  bandana.position.y = 2.0;
  bandana.name = 'bandana';
  bandana.visible = !isSkeleton && !isCaptain;
  group.add(bandana);

  const healthBarRoot = new THREE.Group();
  healthBarRoot.position.set(0, 2.38, 0);
  healthBarRoot.visible = false;
  const healthBarBack = new THREE.Mesh(
    new THREE.PlaneGeometry(0.98, 0.17),
    new THREE.MeshBasicMaterial({ color: 0x081015, transparent: true, opacity: 0.82, depthWrite: false }),
  );
  healthBarBack.position.z = -0.003;
  healthBarBack.renderOrder = 10;
  healthBarRoot.add(healthBarBack);
  const healthBarFill = new THREE.Mesh(
    new THREE.PlaneGeometry(0.84, 0.08),
    new THREE.MeshBasicMaterial({ color: 0x69d57b, transparent: true, opacity: 0.96, depthWrite: false }),
  );
  healthBarFill.position.z = 0.003;
  healthBarFill.renderOrder = 11;
  healthBarRoot.add(healthBarFill);
  group.add(healthBarRoot);

  group.userData.animation = {
    phase: Math.random() * Math.PI * 2,
    variant,
    parts: {
      torso,
      shirt,
      pelvis,
      coatSkirt,
      leftArmPivot,
      rightArmPivot,
      leftLegPivot,
      rightLegPivot,
      head,
      hair,
      bandana,
    },
  };
  group.userData.healthBar = {
    root: healthBarRoot,
    fill: healthBarFill,
    fullWidth: 0.84,
  };

  return group;
}

function makeHeldWeaponMesh(weaponId: WeaponInstance['weaponId']): THREE.Group {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6a4322, roughness: 0.95 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xb9c2c9, roughness: 0.45, metalness: 0.75 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xb88a34, roughness: 0.5, metalness: 0.85 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x26201a, roughness: 0.95 });

  if (weaponId === 'cutlass') {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.03), steelMat);
    blade.position.set(0, 0.5, 0);
    blade.castShadow = true;
    group.add(blade);

    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.16, 5), steelMat);
    tip.position.set(0, 1.02, 0);
    tip.castShadow = true;
    group.add(tip);

    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 6, 12), brassMat);
    guard.rotation.x = Math.PI * 0.5;
    guard.position.y = 0.06;
    guard.castShadow = true;
    group.add(guard);

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.28, 8), darkMat);
    grip.position.y = -0.13;
    grip.castShadow = true;
    group.add(grip);

    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), brassMat);
    pommel.position.y = -0.3;
    pommel.castShadow = true;
    group.add(pommel);
    return group;
  }

  if (weaponId === 'flintknock') {
    // Compact flintlock pistol: short barrel, angled grip, lock plate + cock — not the long-gun stock/barrel mesh.
    const blLen = 0.36;
    const barrelZ = 0.06 + blLen * 0.5;

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.12, 0.1), woodMat);
    grip.position.set(0, -0.1, -0.04);
    grip.rotation.x = -0.14;
    grip.castShadow = true;
    group.add(grip);

    const gripCap = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), brassMat);
    gripCap.position.set(0, -0.158, -0.07);
    gripCap.castShadow = true;
    group.add(gripCap);

    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.085, 0.11), woodMat);
    frame.position.set(0, 0.01, -0.04);
    frame.castShadow = true;
    group.add(frame);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.04, blLen, 8), steelMat);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(0, 0.045, barrelZ);
    barrel.castShadow = true;
    group.add(barrel);

    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.036, 0.055, 8), brassMat);
    muzzle.rotation.x = Math.PI * 0.5;
    muzzle.position.set(0, 0.045, 0.06 + blLen + 0.02);
    muzzle.castShadow = true;
    group.add(muzzle);

    const lockPlate = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.075, 0.095), brassMat);
    lockPlate.position.set(0.048, 0.055, 0.02);
    lockPlate.castShadow = true;
    group.add(lockPlate);

    const frizzen = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.045, 0.032), brassMat);
    frizzen.position.set(0.052, 0.078, 0.055);
    frizzen.rotation.x = -0.4;
    frizzen.castShadow = true;
    group.add(frizzen);

    const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.075, 0.022), darkMat);
    hammer.position.set(-0.018, 0.118, 0.015);
    hammer.rotation.z = 0.52;
    hammer.castShadow = true;
    group.add(hammer);

    const triggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.048, 0.012, 6, 14, Math.PI * 1.08), brassMat);
    triggerGuard.rotation.x = Math.PI * 0.5;
    triggerGuard.position.set(0, -0.045, 0.04);
    triggerGuard.castShadow = true;
    group.add(triggerGuard);

    const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.014), darkMat);
    trigger.position.set(0, -0.065, 0.045);
    trigger.castShadow = true;
    group.add(trigger);

    return group;
  }

  if (weaponId === 'eye_of_reach') {
    const hideWhenScoped = (mesh: THREE.Mesh, name?: string) => {
      if (name) mesh.name = name;
      mesh.userData.eorHideInScope = true;
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };
    const keepWhenScoped = (mesh: THREE.Mesh, name?: string) => {
      if (name) mesh.name = name;
      mesh.userData.eorKeepInScope = true;
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };

    const shoulder = hideWhenScoped(
      new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.128, 0.42, 14), woodMat),
      'vm-eor-butt',
    );
    shoulder.rotation.x = Math.PI * 0.5;
    shoulder.position.set(0, -0.04, -0.36);
    shoulder.scale.set(0.82, 1, 1.18);

    const buttPlate = hideWhenScoped(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.18, 0.035), brassMat));
    buttPlate.name = 'vm-eor-stock';
    buttPlate.position.set(0, -0.05, -0.59);

    const cheekRest = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.058, 0.32, 12), woodMat));
    cheekRest.rotation.x = Math.PI * 0.5;
    cheekRest.position.set(0, 0.055, -0.32);
    cheekRest.scale.set(0.75, 1, 0.72);

    const wrist = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.068, 0.28, 12), woodMat));
    wrist.rotation.x = Math.PI * 0.5;
    wrist.position.set(0, -0.015, -0.095);
    wrist.scale.set(0.86, 1, 1.05);

    const grip = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.054, 0.24, 10), woodMat), 'vm-eor-grip');
    grip.position.set(0, -0.14, -0.04);
    grip.rotation.x = -0.24;
    grip.scale.set(0.82, 1, 1);

    const receiver = hideWhenScoped(new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.084, 0.16), steelMat));
    receiver.position.set(0, 0.035, 0.03);

    const lockPlate = hideWhenScoped(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.065, 0.15), brassMat));
    lockPlate.position.set(0.057, 0.048, 0.01);

    const hammer = hideWhenScoped(new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.076, 0.028), darkMat));
    hammer.position.set(-0.022, 0.11, -0.015);
    hammer.rotation.z = 0.48;

    const triggerGuard = hideWhenScoped(new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.01, 6, 14, Math.PI * 1.16), brassMat));
    triggerGuard.rotation.x = Math.PI * 0.5;
    triggerGuard.position.set(0, -0.056, 0.035);

    const foreEnd = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.056, 0.66, 12), woodMat));
    foreEnd.rotation.x = Math.PI * 0.5;
    foreEnd.position.set(0, 0.008, 0.34);
    foreEnd.scale.set(0.82, 1, 1);

    const barrel = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.028, 1.34, 16), steelMat), 'vm-eor-barrel');
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(0, 0.075, 0.58);

    for (const z of [0.15, 0.38]) {
      const band = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.061, 0.061, 0.038, 14), brassMat));
      band.rotation.x = Math.PI * 0.5;
      band.position.set(0, 0.04, z);
    }

    const muzzle = hideWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.025, 0.075, 14), brassMat));
    muzzle.rotation.x = Math.PI * 0.5;
    muzzle.position.set(0, 0.075, 1.27);

    const frontSight = hideWhenScoped(new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.035, 0.018), brassMat));
    frontSight.position.set(0, 0.118, 1.2);

    const scopeTube = keepWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.48, 16), darkMat), 'vm-eor-scope');
    scopeTube.rotation.x = Math.PI * 0.5;
    scopeTube.position.set(0, 0.16, 0.25);

    const scopeRear = keepWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.062, 0.12, 16), brassMat));
    scopeRear.rotation.x = Math.PI * 0.5;
    scopeRear.position.set(0, 0.16, -0.03);

    const scopeFront = keepWhenScoped(new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.044, 0.13, 16), brassMat));
    scopeFront.rotation.x = Math.PI * 0.5;
    scopeFront.position.set(0, 0.16, 0.55);

    const lensMat = new THREE.MeshBasicMaterial({ color: 0x7cb9d8, transparent: true, opacity: 0.7, depthWrite: false });
    const lens = keepWhenScoped(new THREE.Mesh(new THREE.CircleGeometry(0.049, 16), lensMat));
    lens.position.set(0, 0.16, 0.625);

    for (const z of [0.08, 0.34]) {
      const mount = keepWhenScoped(new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.092, 0.038), brassMat));
      mount.position.set(0, 0.11, z);
    }

    return group;
  }

  if (weaponId === 'blunderbuss') {
    const addPart = (mesh: THREE.Mesh) => {
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };

    const shoulder = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.148, 0.38, 14), woodMat));
    shoulder.rotation.x = Math.PI * 0.5;
    shoulder.position.set(0, -0.04, -0.33);
    shoulder.scale.set(0.82, 1, 1.16);

    const buttPlate = addPart(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.19, 0.036), brassMat));
    buttPlate.position.set(0, -0.055, -0.54);

    const grip = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.064, 0.25, 10), woodMat));
    grip.position.set(0, -0.15, -0.045);
    grip.rotation.x = -0.28;
    grip.scale.set(0.86, 1, 1);

    const receiver = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.07, 0.16, 12), steelMat));
    receiver.rotation.x = Math.PI * 0.5;
    receiver.position.set(0, 0.03, 0.045);

    const foreEnd = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.064, 0.42, 12), woodMat));
    foreEnd.rotation.x = Math.PI * 0.5;
    foreEnd.position.set(0, -0.005, 0.25);
    foreEnd.scale.set(0.84, 1, 1);

    const barrel = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.046, 0.76, 18), steelMat));
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(0, 0.055, 0.48);

    const muzzleLip = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.12, 0.095, 18), brassMat));
    muzzleLip.rotation.x = Math.PI * 0.5;
    muzzleLip.position.set(0, 0.055, 0.905);

    const muzzleDark = addPart(new THREE.Mesh(new THREE.CircleGeometry(0.104, 18), darkMat));
    muzzleDark.position.set(0, 0.055, 0.958);

    for (const z of [0.18, 0.43, 0.72]) {
      const band = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.073 + z * 0.035, 0.064 + z * 0.03, 0.036, 16), brassMat));
      band.rotation.x = Math.PI * 0.5;
      band.position.set(0, 0.04, z);
    }

    const ramrod = addPart(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.67, 8), darkMat));
    ramrod.rotation.x = Math.PI * 0.5;
    ramrod.position.set(0, -0.052, 0.43);

    const lockPlate = addPart(new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.066, 0.14), brassMat));
    lockPlate.position.set(0.064, 0.045, 0.025);

    const hammer = addPart(new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.076, 0.028), darkMat));
    hammer.position.set(-0.025, 0.108, -0.01);
    hammer.rotation.z = 0.52;

    const triggerGuard = addPart(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.011, 6, 14, Math.PI * 1.12), brassMat));
    triggerGuard.rotation.x = Math.PI * 0.5;
    triggerGuard.position.set(0, -0.062, 0.038);

    return group;
  }

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.24, 0.14), woodMat);
  grip.position.set(0, -0.1, -0.02);
  grip.castShadow = true;
  group.add(grip);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.14, 0.32), woodMat);
  stock.position.set(0, 0, -0.15);
  stock.castShadow = true;
  group.add(stock);

  const barrelLength = weaponId === 'flintlock' ? 0.72 : 0.56;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.04, barrelLength, 8), steelMat);
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0.02, 0.22 + barrelLength * 0.3);
  barrel.castShadow = true;
  group.add(barrel);

  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.08, 8), brassMat);
  muzzle.rotation.x = Math.PI * 0.5;
  muzzle.position.set(0, 0.02, 0.22 + barrelLength * 0.6);
  muzzle.castShadow = true;
  group.add(muzzle);

  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.04), darkMat);
  hammer.position.set(0, 0.12, 0.02);
  hammer.castShadow = true;
  group.add(hammer);

  return group;
}

type PocketPreviewKind = 'banana' | 'wood' | 'coconut' | 'mango' | 'powder_keg' | 'shovel';

function makePocketPreviewMesh(kind: PocketPreviewKind): THREE.Group {
  const group = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf0c040, roughness: 0.42 });
  const husk = new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.88 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a4e28, roughness: 0.9 });
  const flesh = new THREE.MeshStandardMaterial({ color: 0xff9a30, roughness: 0.48 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x3d8f42, roughness: 0.65 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x2d3034, roughness: 0.58, metalness: 0.7 });
  const fuseMat = new THREE.MeshStandardMaterial({ color: 0x1d1711, roughness: 0.92 });

  if (kind === 'powder_keg') {
    const kegWood = new THREE.MeshStandardMaterial({
      color: 0x6b421f,
      emissive: 0x160b04,
      emissiveIntensity: 0.12,
      roughness: 0.94,
    });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0x8f5f3c, roughness: 0.82 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.13, 0.25, 14), kegWood);
    group.add(body);

    for (const y of [-0.085, 0.085]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.118, 0.011, 6, 18), iron);
      hoop.rotation.x = Math.PI * 0.5;
      hoop.position.y = y;
      group.add(hoop);
    }

    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.098, 0.028, 14), woodMat);
    top.position.y = 0.14;
    group.add(top);

    const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.094, 0.026, 14), woodMat);
    bottom.position.y = -0.14;
    group.add(bottom);

    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.013, 0.14, 6), fuseMat);
    fuse.position.set(0.045, 0.215, 0.015);
    fuse.rotation.z = -0.48;
    group.add(fuse);

    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffa23a }),
    );
    spark.position.set(0.078, 0.275, 0.02);
    group.add(spark);

    const sparkLight = new THREE.PointLight(0xff8a2a, 0.75, 0.7);
    sparkLight.position.copy(spark.position);
    group.add(sparkLight);

    for (const side of [-1, 1]) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 7), skinMat);
      hand.position.set(side * 0.13, -0.035, 0.052);
      hand.scale.set(1.25, 0.82, 0.9);
      group.add(hand);

      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.032, 0.18, 8), husk);
      sleeve.position.set(side * 0.18, -0.14, 0.09);
      sleeve.rotation.z = side * 0.42;
      group.add(sleeve);
    }
  } else if (kind === 'banana') {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.028, 8, 20, Math.PI * 1.12), yellow);
    arc.rotation.x = Math.PI * 0.5;
    arc.rotation.z = Math.PI * 0.5;
    group.add(arc);
  } else if (kind === 'wood') {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.055, 0.4), woodMat);
    group.add(plank);
  } else if (kind === 'shovel') {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.62, 8), woodMat);
    handle.rotation.x = Math.PI * 0.5;
    handle.position.z = -0.08;
    group.add(handle);

    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.04, 0.055, 10), iron);
    collar.rotation.x = Math.PI * 0.5;
    collar.position.z = 0.23;
    group.add(collar);

    const spade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.036, 0.22), iron);
    spade.position.z = 0.36;
    spade.scale.set(1, 0.55, 1.25);
    group.add(spade);

    const grip = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 14), woodMat);
    grip.rotation.x = Math.PI * 0.5;
    grip.position.z = -0.42;
    group.add(grip);
  } else if (kind === 'coconut') {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), husk);
    group.add(shell);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.03, 0.055, 6), leaf);
    stem.position.y = 0.1;
    group.add(stem);
  } else {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), flesh);
    body.scale.set(1.05, 0.82, 1.12);
    group.add(body);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.14, 6), leaf);
    cap.position.set(0.05, 0.08, 0.04);
    cap.rotation.z = -0.55;
    group.add(cap);
  }

  return group;
}

function applyViewmodelMaterialSettings(root: THREE.Object3D) {
  root.traverse((object) => {
    object.frustumCulled = false;
    if (object instanceof THREE.Mesh) {
      object.castShadow = false;
      object.receiveShadow = false;
      object.renderOrder = 999;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.depthTest = false;
        material.depthWrite = false;
        material.polygonOffset = false;
      }
    }
  });
}

function makeProjectileMesh(projectile: Projectile): THREE.Mesh {
  const colorByType: Record<Projectile['type'], number> = {
    bullet: 0xf7e7a9,
    cannonball: 0x2e2e2e,
    firebomb: 0xff6b2d,
    chainshot: 0x91b7c8,
  };

  const radius = projectile.type === 'bullet' ? 0.08 : 0.26;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 12),
    new THREE.MeshStandardMaterial({
      color: colorByType[projectile.type],
      emissive: projectile.type === 'firebomb' ? 0xaa3300 : 0x000000,
      emissiveIntensity: projectile.type === 'firebomb' ? 1.2 : 0,
      roughness: projectile.type === 'cannonball' ? 0.95 : 0.45,
      metalness: projectile.type === 'cannonball' ? 0.2 : 0,
    }),
  );
  mesh.castShadow = true;
  return mesh;
}

function makeStormTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(18, 27, 45, 0)');
  gradient.addColorStop(0.16, 'rgba(39, 57, 90, 0.38)');
  gradient.addColorStop(0.5, 'rgba(47, 66, 104, 0.82)');
  gradient.addColorStop(0.84, 'rgba(32, 47, 75, 0.42)');
  gradient.addColorStop(1, 'rgba(18, 27, 45, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 60; index++) {
    const x = Math.random() * canvas.width;
    const width = 2 + Math.random() * 6;
    const alpha = 0.035 + Math.random() * 0.08;
    ctx.fillStyle = `rgba(120, 158, 196, ${alpha})`;
    ctx.fillRect(x, 0, width, canvas.height);
  }

  for (let index = 0; index < 36; index++) {
    const y = Math.random() * canvas.height;
    const height = 8 + Math.random() * 28;
    const alpha = 0.04 + Math.random() * 0.08;
    ctx.fillStyle = `rgba(16, 25, 48, ${alpha})`;
    ctx.fillRect(0, y, canvas.width, height);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(18, 1);
  return texture;
}

function makeWindWispTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 24;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  const gradient = ctx.createLinearGradient(0, canvas.height * 0.5, canvas.width, canvas.height * 0.5);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.18, 'rgba(215,240,255,0.12)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.82, 'rgba(215,240,255,0.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height * 0.5);
  ctx.quadraticCurveTo(canvas.width * 0.18, 0, canvas.width * 0.42, canvas.height * 0.34);
  ctx.quadraticCurveTo(canvas.width * 0.7, canvas.height * 0.8, canvas.width, canvas.height * 0.5);
  ctx.quadraticCurveTo(canvas.width * 0.7, canvas.height, canvas.width * 0.42, canvas.height * 0.66);
  ctx.quadraticCurveTo(canvas.width * 0.18, canvas.height * 0.08, 0, canvas.height * 0.5);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function makeUpgradeSignTexture(title: string, effect: string, accentHex: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }

  const accent = `#${accentHex.toString(16).padStart(6, '0')}`;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(58, 38, 20, 0.98)');
  gradient.addColorStop(1, 'rgba(24, 18, 13, 0.98)');
  ctx.fillStyle = gradient;
  ctx.fillRect(12, 12, canvas.width - 24, canvas.height - 24);
  ctx.lineWidth = 8;
  ctx.strokeStyle = accent;
  ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(244, 222, 174, 0.78)';
  ctx.strokeRect(34, 34, canvas.width - 68, canvas.height - 68);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f6ead1';
  ctx.font = '700 44px Georgia, serif';
  ctx.fillText(title.toUpperCase(), canvas.width * 0.5, 72);
  ctx.fillStyle = accent;
  ctx.font = '700 28px system-ui, sans-serif';
  ctx.fillText(effect, canvas.width * 0.5, 122);
  ctx.fillStyle = 'rgba(246, 234, 209, 0.78)';
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.fillText('UPGRADE FORGE', canvas.width * 0.5, 157);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makeUpgradeStationProp(type: ShipUpgradeType, accentHex: number) {
  const prop = new THREE.Group();
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentHex,
    emissive: accentHex,
    emissiveIntensity: 0.14,
    roughness: 0.56,
    metalness: 0.25,
    side: THREE.DoubleSide,
  });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a351f, roughness: 0.94 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x343b43, roughness: 0.54, metalness: 0.7 });
  const clothMat = new THREE.MeshStandardMaterial({ color: 0xf3ead2, roughness: 0.86, side: THREE.DoubleSide });

  if (type === 'hull_reinforcement') {
    const shieldShape = new THREE.Shape();
    shieldShape.moveTo(0, 0.38);
    shieldShape.lineTo(0.27, 0.22);
    shieldShape.lineTo(0.21, -0.16);
    shieldShape.lineTo(0, -0.42);
    shieldShape.lineTo(-0.21, -0.16);
    shieldShape.lineTo(-0.27, 0.22);
    shieldShape.lineTo(0, 0.38);
    const shield = new THREE.Mesh(new THREE.ShapeGeometry(shieldShape), accentMat);
    shield.position.set(0, 1.08, 0.38);
    prop.add(shield);

    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.58, 0.07), steelMat);
    brace.position.set(0, 1.03, 0.42);
    prop.add(brace);
  } else if (type === 'charged_cannons') {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.08, 0.54, 14), steelMat);
    barrel.rotation.z = Math.PI * 0.5;
    barrel.position.set(0, 0.92, 0.34);
    prop.add(barrel);

    const carriage = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.16, 0.28), woodMat);
    carriage.position.set(0, 0.72, 0.34);
    prop.add(carriage);

    for (const x of [-0.18, 0.18]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 12), woodMat);
      wheel.rotation.x = Math.PI * 0.5;
      wheel.position.set(x, 0.63, 0.48);
      prop.add(wheel);
    }

    for (let i = 0; i < 3; i++) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), steelMat);
      ball.position.set(-0.34 + i * 0.14, 0.68 + (i === 1 ? 0.11 : 0), 0.05);
      prop.add(ball);
    }
  } else {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.78, 8), woodMat);
    mast.position.set(-0.17, 0.95, 0.36);
    prop.add(mast);

    const sailShape = new THREE.Shape();
    sailShape.moveTo(-0.13, 0.34);
    sailShape.lineTo(0.26, 0.12);
    sailShape.lineTo(-0.13, -0.34);
    sailShape.lineTo(-0.13, 0.34);
    const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), clothMat);
    sail.position.set(0.02, 0.95, 0.38);
    prop.add(sail);

    const streak = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.022), accentMat);
    streak.position.set(0.06, 0.95, 0.405);
    streak.rotation.z = -0.34;
    prop.add(streak);
  }

  prop.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
    }
  });
  return prop;
}

export class Game {
  private readonly renderer = new Renderer();
  private readonly ocean = new OceanRenderer();
  private readonly shipRenderer = new ShipRenderer();
  private readonly combatFx = new CombatFx();
  private readonly network = new NetworkClient();
  private readonly input = new InputManager();
  private readonly ui: UiRefs = {
    loadingScreen: requireElement('loading-screen'),
    loadingBar: requireElement('loading-bar'),
    loadingText: requireElement('loading-text'),
    compassTape: requireElement('compass-tape'),
    stormPhase: requireElement('storm-phase'),
    stormTimer: requireElement('storm-timer'),
    stormWarning: requireElement('storm-warning'),
    shipsAlive: requireElement('ships-alive'),
    goldAmount: requireElement('gold-amount'),
    healthFill: requireElement('health-fill'),
    armorFill: requireElement('armor-fill'),
    hullBow: requireElement('hull-bow'),
    hullStern: requireElement('hull-stern'),
    hullPort: requireElement('hull-port'),
    hullStarboard: requireElement('hull-starboard'),
    hullBowTxt: requireElement('hull-bow-txt'),
    hullSternTxt: requireElement('hull-stern-txt'),
    hullPortTxt: requireElement('hull-port-txt'),
    hullStarboardTxt: requireElement('hull-starboard-txt'),
    sailStatus: requireElement('sail-status'),
    shipUpgrades: requireElement('ship-upgrades'),
    ammoCurrent: requireElement('ammo-current'),
    ammoReserve: requireElement('ammo-reserve'),
    reloadIndicator: requireElement('reload-indicator'),
    weaponSlots: [0, 1, 2, 3].map((index) => requireElement(`slot-${index}`)),
    inventoryWood: requireElement('inv-wood'),
    inventoryCannonball: requireElement('inv-cannonball'),
    inventoryFirebomb: requireElement('inv-firebomb'),
    inventoryChainshot: requireElement('inv-chainshot'),
    inventoryBanana: requireElement('inv-banana'),
    shipInventory: requireElement('ship-inventory'),
    kegStatus: requireElement('keg-status'),
    kegStatusValue: requireElement('keg-status-value'),
    interactPrompt: requireElement('interact-prompt'),
    contextLabel: requireElement('context-label'),
    crosshair: requireElement('crosshair'),
    hitMarker: requireElement('hit-marker'),
    damageIndicatorLayer: requireElement('damage-indicator-layer'),
    scopeOverlay: requireElement('scope-overlay'),
    killFeed: requireElement('kill-feed'),
    damageVignette: requireElement('damage-vignette'),
    knockbackFlash: requireElement('knockback-flash'),
    tradeUi: requireElement('trade-ui'),
    yourTradeItems: requireElement('your-trade-items'),
    theirTradeItems: requireElement('their-trade-items'),
    tradeConfirm: requireElement('trade-confirm'),
    tradeCancel: requireElement('trade-cancel'),
    tradeTimer: requireElement('trade-timer'),
    deathScreen: requireElement('death-screen'),
    deathStats: requireElement('death-stats'),
    winScreen: requireElement('win-screen'),
    winStats: requireElement('win-stats'),
    minimapCanvas: requireElement('minimap-canvas'),
    mapOverlay: requireElement('map-overlay'),
    mapCanvas: requireElement('map-canvas'),
    mapSubtitle: requireElement('map-subtitle'),
    islandBanner: requireElement('island-banner'),
    pocketWheel: requireElement('pocket-wheel'),
    pocketWheelStats: requireElement('pocket-wheel-stats'),
    pocketStrip: requireElement('pocket-strip'),
    treasureChart: requireElement('treasure-chart'),
    treasureChartCanvas: requireElement('treasure-chart-canvas'),
    treasureChartIsland: requireElement('treasure-chart-island'),
    treasureChartRoute: requireElement('treasure-chart-route'),
  };

  private state: GameState | null = null;
  private playersById = new Map<string, Player>();
  private shipsById = new Map<string, Ship>();
  private livePlayerIds = new Set<string>();
  private liveProjectileIds = new Set<string>();
  private liveKegIds = new Set<string>();
  private localPlayerId: string | null = null;
  private localShipId: string | null = null;
  private returningToLobby = false;
  private lastFrameTime = performance.now();
  private frameDt = 1 / 60;
  private hudTimer = 0;
  private minimapTimer = 0;
  private interactScanTimer = 0;
  private slowSceneTimer = 0;
  private inputSendTimer = 0;
  private previousHealth: number = PLAYER.MAX_HEALTH;
  private previousKnockback = 0;
  private activeTradeSessionId: string | null = null;
  private localTradeOffer: ItemStack[] = [];
  private mapOpen = false;
  private previousLocalState: Player['state'] | null = null;
  private prevIsInsideIsland: string | null = null;
  private islandBannerHideAt = 0;
  private islandArrivalAudioCtx: AudioContext | null = null;
  private lightningFlash: THREE.PointLight | null = null;
  private lightningTimer = 4 + Math.random() * 6;
  private stormWeatherIntensity = 0;
  private stormRainCanvas: HTMLCanvasElement | null = null;
  private stormRainCtx: CanvasRenderingContext2D | null = null;
  private stormLightningFlashEl: HTMLDivElement | null = null;
  private stormLightningFlashOpacity = 0;
  private storyCutscene: StoryCutsceneRefs | null = null;
  private storyCutsceneNpcId: string | null = null;
  private storyCutsceneHideAt = 0;
  /** Matches the HUD [X] prompt — server must perform this action only. */
  private lastInteractKind: InteractIntent | null = null;
  private visibleInteractKind: InteractIntent | null = null;
  private pendingInteractFromUi = false;
  private pendingLaunchFromUi = false;
  private readonly stormRingPositions = new Float32Array(96 * 3);
  private readonly stormWallColorClear = new THREE.Color(0x395270);
  private readonly stormWallColorStorm = new THREE.Color(0x202a3f);
  private readonly stormWallTexture = makeStormTexture();
  private readonly windWispTexture = makeWindWispTexture();
  private readonly tempProjectilePos = new THREE.Vector3();
  private readonly tempHudVector = new THREE.Vector3();
  private readonly localViewWeaponRoot = new THREE.Group();
  private readonly localViewPocketRoot = new THREE.Group();
  private localViewPocketKind: PocketPreviewKind | null = null;
  private pocketUsePreviewKind: PocketPreviewKind | null = null;
  private pocketUsePreviewTimer = 0;
  private treasureChartSignature = '';
  private pocketStripSignature = '';
  private shipUpgradeSignature = '';
  private shipInventorySignature = '';
  private localViewWeaponId: WeaponInstance['weaponId'] | null = null;
  private localViewWeaponKick = 0;
  private localViewWeaponReloadPhase = 0;
  private localViewWeaponAmmoSignature = '';
  private lastSnapshotAt = performance.now();
  private hitMarkerTimer = 0;
  private hitMarkerHeadshot = false;
  private hitMarkerKill = false;
  private hitMarkerShip = false;
  private hitMarkerShark = false;
  private readonly floatingDamageIndicators: FloatingDamageIndicator[] = [];

  private readonly islandMeshes = new Map<string, THREE.Group>();
  private readonly chestMeshes = new Map<string, ChestMeshRecord>();
  private readonly barrelMeshes = new Map<string, THREE.Group>();
  private readonly sharkMeshes = new Map<string, THREE.Group>();
  private readonly kegMeshes = new Map<string, KegMeshRecord>();
  private readonly upgradeStationMeshes = new Map<string, UpgradeStationMeshRecord>();
  private readonly npcMeshes = new Map<string, NpcMeshRecord>();
  private readonly playerMeshes = new Map<string, THREE.Group>();
  private readonly projectileMeshes = new Map<string, THREE.Mesh>();
  private readonly windWispMeshes: WindWispRecord[] = [];
  private readonly seenStoryNpcIds = new Set<string>();

  private readonly environment = new THREE.Group();
  private readonly windWisps = new THREE.Group();
  private readonly stormRing = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x587ca5, transparent: true, opacity: 0.58 }),
  );
  private readonly stormWall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 120, 72, 1, true),
    new THREE.MeshBasicMaterial({
      map: this.stormWallTexture,
      color: 0x395270,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  private readonly stormHalo = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.05, 8, 64),
    new THREE.MeshBasicMaterial({
      color: 0x25344f,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );

  async init() {
    this.setLoading(12, 'Hoisting sails...');
    document.addEventListener('contextmenu', (event) => event.preventDefault());

    this.renderer.init();
    this.setupStormWeatherOverlay();
    this.setupStoryCutsceneOverlay();
    this.bindInteractPromptClick();
    this.localViewWeaponRoot.visible = false;
    this.localViewWeaponRoot.renderOrder = 999;
    this.renderer.camera.add(this.localViewWeaponRoot);
    this.localViewPocketRoot.visible = false;
    this.localViewPocketRoot.renderOrder = 999;
    this.renderer.camera.add(this.localViewPocketRoot);
    this.ocean.init(this.renderer.scene);
    this.shipRenderer.init(this.renderer.scene);
    this.combatFx.init(this.renderer.scene);
    this.renderer.scene.add(this.environment);
    this.renderer.scene.add(this.windWisps);
    this.renderer.scene.add(this.stormRing);
    this.renderer.scene.add(this.stormWall);
    this.renderer.scene.add(this.stormHalo);
    this.initWindWisps();
    this.stormRing.geometry.setAttribute('position', new THREE.BufferAttribute(this.stormRingPositions, 3));
    this.stormRing.position.y = 0.55;
    this.stormRing.frustumCulled = false;
    this.stormWall.position.y = 44;
    this.stormWall.renderOrder = 1;
    this.stormWall.frustumCulled = false;
    this.stormHalo.rotation.x = Math.PI * 0.5;
    this.stormHalo.renderOrder = 2;
    this.stormHalo.frustumCulled = false;

    this.input.init(this.renderer.renderer.domElement);
    this.bindSupplyWheelActions();
    document.body.addEventListener('pointerdown', () => this.combatFx.unlockAudio());
    this.bindMapUiActions();
    this.bindTradeUiActions();
    this.bindNetworkEvents();

    await this.waitForLobbyLaunch('Ready to sail...', 'Enter 7-Crew Seas');
    await this.connectToMatch();

    requestAnimationFrame((time) => this.frame(time));
  }

  private async waitForLobbyLaunch(message: string, buttonText: string) {
    const playBtn = document.getElementById('play-btn');
    this.ui.loadingScreen.style.display = 'flex';
    this.ui.loadingScreen.style.opacity = '1';
    this.ui.loadingScreen.style.pointerEvents = 'auto';
    this.setLoading(28, message);

    if (!playBtn) return;
    playBtn.textContent = buttonText;
    playBtn.style.display = 'block';
    await new Promise<void>((resolve) => {
      playBtn.addEventListener('click', () => {
        playBtn.style.display = 'none';
        resolve();
      }, { once: true });
    });
  }

  private async connectToMatch() {
    this.resetLocalRoundState();
    this.setLoading(38, 'Opening a fresh 7-crew sea lane...');
    await this.network.connect(this.getSocketUrl());
    this.setLoading(68, 'Waiting for ship assignment...');
  }

  private resetLocalRoundState() {
    this.state = null;
    this.localPlayerId = null;
    this.localShipId = null;
    this.playersById.clear();
    this.shipsById.clear();
    this.livePlayerIds.clear();
    this.liveProjectileIds.clear();
    this.liveKegIds.clear();
    this.previousHealth = PLAYER.MAX_HEALTH;
    this.previousKnockback = 0;
    this.previousLocalState = null;
    this.prevIsInsideIsland = null;
    this.activeTradeSessionId = null;
    this.localTradeOffer = [];
    this.mapOpen = false;
    this.hitMarkerTimer = 0;
    this.hitMarkerHeadshot = false;
    this.hitMarkerKill = false;
    this.hitMarkerShip = false;
    this.hitMarkerShark = false;
    this.localViewWeaponId = null;
    this.localViewWeaponAmmoSignature = '';
    this.localViewWeaponKick = 0;
    this.localViewWeaponReloadPhase = 0;
    this.localViewPocketKind = null;
    this.pocketUsePreviewKind = null;
    this.pocketUsePreviewTimer = 0;

    document.getElementById('hud')?.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    this.ui.winScreen.style.display = 'none';
    this.ui.tradeUi.style.display = 'none';
    this.ui.mapOverlay.classList.remove('visible');
    this.ui.scopeOverlay.style.display = 'none';
    this.ui.hitMarker.className = '';
    this.ui.killFeed.innerHTML = '';
    this.ui.damageIndicatorLayer.innerHTML = '';
    this.ui.crosshair.className = '';
    this.ui.crosshair.style.removeProperty('--shotgun-spread');
    this.ui.islandBanner.classList.remove('visible');
    this.localViewWeaponRoot.visible = false;
    this.localViewWeaponRoot.clear();
    this.localViewPocketRoot.visible = false;
    this.localViewPocketRoot.clear();

    for (const indicator of this.floatingDamageIndicators) {
      indicator.element.remove();
    }
    this.floatingDamageIndicators.length = 0;

    for (const mesh of this.playerMeshes.values()) this.renderer.scene.remove(mesh);
    for (const mesh of this.projectileMeshes.values()) this.renderer.scene.remove(mesh);
    for (const record of this.kegMeshes.values()) this.renderer.scene.remove(record.root);

    this.environment.clear();
    this.shipRenderer.clear();
    this.islandMeshes.clear();
    this.chestMeshes.clear();
    this.barrelMeshes.clear();
    this.sharkMeshes.clear();
    this.kegMeshes.clear();
    this.upgradeStationMeshes.clear();
    this.npcMeshes.clear();
    this.playerMeshes.clear();
    this.projectileMeshes.clear();
    this.seenStoryNpcIds.clear();
  }

  private returnToLobbyAfterLoss(kills: number, gold: number, reason = 'Defeated') {
    if (this.returningToLobby) return;
    this.returningToLobby = true;
    this.network.disconnect();
    this.resetLocalRoundState();
    void (async () => {
      await this.waitForLobbyLaunch(`${reason} · Kills ${kills} · Gold ${gold}`, 'Start New 7-Crew Match');
      this.returningToLobby = false;
      await this.connectToMatch();
    })().catch((error) => {
      console.error(error);
      this.setLoading(0, 'Failed to launch new match. Refresh and try again.');
    });
  }

  private bindMapUiActions() {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;

      if (event.code === 'KeyM') {
        this.toggleMap();
      } else if (event.code === 'Escape' && this.mapOpen) {
        this.toggleMap(false);
      }
    });
  }

  private bindSupplyWheelActions() {
    for (const slice of this.ui.pocketWheel.querySelectorAll<SVGPathElement>('[data-wheel-slot]')) {
      slice.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const slot = Number(slice.dataset.wheelSlot);
        if (!Number.isInteger(slot)) return;
        this.input.queueWheelSlot(slot);
        this.startPocketUsePreview(slot);
      });
    }
  }

  private bindNetworkEvents() {
    this.network.onJoin = (playerId, shipId, snapshot) => {
      this.localPlayerId = playerId;
      this.localShipId = shipId;
      this.previousHealth = PLAYER.MAX_HEALTH;
      this.applySnapshot(snapshot);
      this.setLoading(100, 'Battle underway');
      window.setTimeout(() => {
        this.ui.loadingScreen.style.opacity = '0';
        this.ui.loadingScreen.style.pointerEvents = 'none';
      }, 200);
      window.setTimeout(() => {
        this.ui.loadingScreen.style.display = 'none';
        document.getElementById('hud')?.classList.add('visible');
      }, 650);
    };

    this.network.onSnapshot = (snapshot) => {
      this.applySnapshot(snapshot);
    };

    this.network.onPlayerHit = (payload) => {
      this.handleCombatHit(payload as {
        damage?: number;
        position?: { x: number; y: number; z: number };
        headshot?: boolean;
        kill?: boolean;
        weaponId?: WeaponId;
        targetType?: 'player' | 'shark';
      });
    };

    this.network.onShipHit = (payload) => {
      this.handleCombatHit(payload as {
        damage?: number;
        position?: { x: number; y: number; z: number };
        kill?: boolean;
        remainingHull?: number;
        shipHealthMilestone?: 'half' | 'critical' | null;
      }, true);
    };

    this.network.onKillEvent = (payload) => {
      const event = payload as {
        victimName?: string;
        killerName?: string | null;
        respawning?: boolean;
        headshot?: boolean;
        boardingKill?: boolean;
        stolenGold?: number;
      };
      if (event.killerName && event.victimName) {
        const details = [
          event.headshot ? 'headshot' : '',
          event.boardingKill ? 'boarding raid' : '',
          event.stolenGold ? `+${event.stolenGold} gold` : '',
        ].filter(Boolean).join(' · ');
        this.pushFeed(
          `${event.killerName} dropped ${event.victimName}${details ? ` (${details})` : ''}${event.respawning ? ', but they will respawn.' : '.'}`,
        );
      } else {
        this.pushFeed(event.victimName ? `${event.victimName} went under.` : 'A pirate was eliminated.');
      }
    };

    this.network.onKegExploded = (payload) => {
      const event = payload as { position?: { x: number; y: number; z: number } };
      if (event.position) {
        this.combatFx.emitKegExplosion(event.position, this.renderer.camera.position);
      }
    };

    this.network.onChestOpened = (payload) => {
      const event = payload as { action?: string; value?: number; loot?: Array<{ item: string; qty: number }> };
      if (event.action === 'pickup') {
        this.pushFeed(`Chest taken: worth ${event.value ?? 0} gold at a Gold Hoarder.`, '#d9c17e');
        return;
      }
      if (event.action === 'stow') {
        this.pushFeed(`Chest stowed aboard: ${event.value ?? 0} gold if sold.`, '#d9c17e');
        return;
      }
      const loot = (event.loot ?? [])
        .slice(0, 2)
        .map((entry) => `${entry.qty} ${entry.item.replace(/_/g, ' ')}`)
        .join(', ');
      this.pushFeed(loot ? `Treasure seized: ${loot}` : 'Treasure chest opened.', '#d9c17e');
    };

    this.network.onBarrelOpened = (payload) => {
      const event = payload as { loot?: Array<{ item: string; qty: number }> };
      const loot = (event.loot ?? [])
        .slice(0, 2)
        .map((entry) => `${entry.qty} ${entry.item.replace(/_/g, ' ')}`)
        .join(', ');
      this.pushFeed(loot ? `Barrel supplies: ${loot}` : 'Barrel opened.', '#9ec0e5');
    };

    this.network.onShipUpgraded = (payload) => {
      const event = payload as { shipId?: string; type?: ShipUpgradeType };
      if (!event.type) return;
      const meta = this.getUpgradePresentation(event.type);
      const subject = event.shipId === this.localShipId ? 'Your ship claimed' : 'A crew claimed';
      this.pushFeed(`${subject} ${meta.name}.`, meta.color);
    };

    this.network.onTreasureSold = (payload) => {
      const event = payload as {
        playerName?: string;
        gold?: number;
        totalGold?: number;
        islandName?: string;
      };
      const seller = event.playerName ?? 'A pirate';
      this.pushFeed(
        `${seller} sold a chest for ${event.gold ?? 0} gold (${event.totalGold ?? 0}/${ECONOMY.GOLD_WIN_TARGET}).`,
        '#f0c86a',
      );
    };

    this.network.onTreasureMap = (payload) => {
      const event = payload as { islandName?: string; chestCount?: number };
      this.pushFeed(
        `Gold Hoarder chart: ${event.islandName ?? 'unknown island'} (${event.chestCount ?? 0} X marks).`,
        '#d9c17e',
      );
      if (this.mapOpen) this.drawMaps();
    };

    this.network.onTradeRequest = () => {
      this.pushFeed('Parley signaled between nearby ships.', '#8bc2d7');
    };
    this.network.onTradeUpdate = () => {
      if (this.state) this.syncTradeUi(this.state);
    };
    this.network.onTradeResult = (payload) => {
      const result = payload as { type?: string };
      const label =
        result.type === 'trade_completed' ? 'Trade completed.' :
        result.type === 'trade_betrayed' ? 'Parley broken.' :
        result.type === 'trade_timeout' ? 'Trade offer timed out.' :
        'Trade cancelled.';
      this.pushFeed(label, '#8bc2d7');
      if (this.state) this.syncTradeUi(this.state);
    };

    this.network.onGameOver = (payload) => {
      const result = payload as { died?: boolean; winnerId?: string | null; kills?: number; gold?: number; reason?: string; targetGold?: number };
      const player = this.getLocalPlayer();
      if (result.died) {
        this.returnToLobbyAfterLoss(result.kills ?? player?.kills ?? 0, result.gold ?? player?.gold ?? 0, 'Crew lost');
      } else if (result.winnerId && result.winnerId === this.localPlayerId) {
        this.showVictory(player?.kills ?? 0, result.gold ?? player?.gold ?? 0);
      } else {
        const reason = result.reason === 'gold'
          ? `Enemy reached ${result.targetGold ?? ECONOMY.GOLD_WIN_TARGET} gold`
          : 'Crew lost';
        this.returnToLobbyAfterLoss(player?.kills ?? 0, player?.gold ?? 0, reason);
      }
    };

    this.network.onPlayerSpawned = (payload) => {
      const event = payload as { playerId?: string; mermaid?: boolean };
      if (event.playerId === this.localPlayerId) {
        this.ui.deathScreen.style.display = 'none';
        if (event.mermaid) this.pushFeed('The mermaid returned you to your ship.', '#8bc2d7');
      }
    };
  }

  private bindTradeUiActions() {
    this.ui.tradeConfirm.addEventListener('click', () => {
      if (!this.activeTradeSessionId) return;
      this.network.sendTradeAction({
        action: 'offer',
        sessionId: this.activeTradeSessionId,
        offer: this.localTradeOffer,
      });
      this.network.sendTradeAction({
        action: 'confirm',
        sessionId: this.activeTradeSessionId,
      });
    });

    this.ui.tradeCancel.addEventListener('click', () => {
      if (!this.activeTradeSessionId) return;
      this.network.sendTradeAction({
        action: 'cancel',
        sessionId: this.activeTradeSessionId,
      });
    });
  }

  private handleCombatHit(
    payload: {
      damage?: number;
      position?: { x: number; y: number; z: number };
      headshot?: boolean;
      kill?: boolean;
      weaponId?: WeaponId | string;
      targetType?: 'player' | 'shark';
      remainingHull?: number;
      shipHealthMilestone?: 'half' | 'critical' | null;
    },
    ship = false,
  ) {
    const damage = Math.max(1, Math.round(payload.damage ?? 0));
    const shark = payload.targetType === 'shark';
    this.hitMarkerTimer = Math.max(this.hitMarkerTimer, ship ? 0.22 : shark ? 0.16 : payload.headshot ? 0.18 : 0.14);
    this.hitMarkerHeadshot = this.hitMarkerHeadshot || !!payload.headshot;
    this.hitMarkerKill = this.hitMarkerKill || !!payload.kill;
    this.hitMarkerShip = this.hitMarkerShip || ship;
    this.hitMarkerShark = this.hitMarkerShark || shark;
    if (ship && payload.position) {
      this.combatFx.emitShipHitConfirm(payload.position, this.renderer.camera.position);
    }
    if (ship && payload.shipHealthMilestone) {
      const pct = Math.max(0, Math.round((payload.remainingHull ?? 0) * 100));
      this.pushFeed(
        payload.shipHealthMilestone === 'half'
          ? `Enemy ship at half health (${pct}%).`
          : `Enemy ship critical (${pct}%).`,
        payload.shipHealthMilestone === 'half' ? '#f0c86a' : '#ff9878',
      );
    }
    const wid = payload.weaponId;
    const weaponLabel = wid && wid in WEAPONS ? WEAPONS[wid as WeaponId].name : undefined;
    if (payload.position) {
      this.spawnFloatingDamageIndicator(String(damage), payload.position, {
        headshot: !!payload.headshot,
        kill: !!payload.kill,
        ship,
        weaponLabel,
      });
    }
  }

  private spawnFloatingDamageIndicator(
    text: string,
    position: { x: number; y: number; z: number },
    options?: { headshot?: boolean; kill?: boolean; ship?: boolean; weaponLabel?: string },
  ) {
    const element = document.createElement('div');
    element.className = 'damage-number';
    if (options?.headshot) element.classList.add('headshot');
    if (options?.kill) element.classList.add('kill');
    if (options?.ship) element.classList.add('ship');
    if (options?.weaponLabel && !options.ship) {
      element.innerHTML = `<span class="damage-val">${text}</span><span class="damage-weapon">${options.weaponLabel}</span>`;
    } else {
      element.textContent = text;
    }
    this.ui.damageIndicatorLayer.appendChild(element);
    this.floatingDamageIndicators.push({
      element,
      worldPos: new THREE.Vector3(position.x, position.y + 0.2, position.z),
      life: 0,
      duration: options?.headshot ? 0.72 : 0.62,
      riseSpeed: options?.ship ? 0.7 : 0.95,
    });
  }

  private applySnapshot(snapshot: GameState) {
    const previousLocalState = this.getLocalPlayer()?.state ?? this.previousLocalState;
    this.state = snapshot;
    this.rebuildStateIndexes(snapshot);
    this.lastSnapshotAt = performance.now();
    this.ensureWorldMeshes(snapshot);
    this.syncChests();
    this.syncBarrels();
    this.updateStormRing();
    this.updateDamageFx();
    this.syncTradeUi(snapshot);
    const localPlayer = this.getLocalPlayer();
    if (localPlayer && previousLocalState === 'respawning' && localPlayer.state === 'alive') {
      this.combatFx.emitRespawn(localPlayer.position, this.renderer.camera.position);
    }
    this.previousLocalState = localPlayer?.state ?? null;
  }

  private rebuildStateIndexes(state: GameState) {
    this.playersById = new Map(state.players.map((player) => [player.id, player]));
    this.shipsById = new Map(state.ships.map((ship) => [ship.id, ship]));
    this.livePlayerIds = new Set(state.players.map((player) => player.id));
    this.liveProjectileIds = new Set(state.projectiles.filter((projectile) => projectile.alive).map((projectile) => projectile.id));
    this.liveKegIds = new Set(state.kegs.filter((keg) => keg.timer > 0).map((keg) => keg.id));
  }

  private ensureWorldMeshes(state: GameState) {
    for (const island of state.islands) {
      if (!this.islandMeshes.has(island.id)) {
        this.buildIsland(island);
      }
    }
  }

  private buildIsland(island: Island) {
    const group = new THREE.Group();
    group.position.set(island.position.x, island.position.y, island.position.z);

    const r = island.radius;
    const {
      islandHeading,
      footprintX,
      footprintZ,
    } = island.profile;
    const islandSeed = island.id.split('').reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
    const rng = (seed: number) => {
      const value = Math.sin(seed * 127.13 + islandSeed * 0.173 + r * 0.021) * 43758.5453;
      return value - Math.floor(value);
    };

    const reefMat = new THREE.MeshStandardMaterial({ color: 0x4d4a42, roughness: 1, side: THREE.DoubleSide });
    const cliffMat = new THREE.MeshStandardMaterial({ color: 0x564f3f, roughness: 0.98, side: THREE.DoubleSide });
    const beachColor = new THREE.Color(0xfae8b8);
    const sandColor = new THREE.Color(0xdcbc80);
    const grassColor = new THREE.Color(0x4e8c32);
    const jungleColor = new THREE.Color(0x2e6a22);
    const peakColor = new THREE.Color(0x5a7e38);
    const cliffColor = new THREE.Color(0x7a6e56);
    const mudColor = new THREE.Color(0x907560);
    const boulderMat = new THREE.MeshStandardMaterial({ color: 0x8a7c65, roughness: 1 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5430, roughness: 1 });
    const frondMat = new THREE.MeshStandardMaterial({ color: 0x2a7040, roughness: 0.85, side: THREE.DoubleSide });
    const tuftMat = new THREE.MeshStandardMaterial({ color: 0x5e9040, roughness: 0.95, side: THREE.DoubleSide });
    const fernMat = new THREE.MeshStandardMaterial({ color: 0x246832, roughness: 0.9, side: THREE.DoubleSide });
    const driftwoodMat = new THREE.MeshStandardMaterial({ color: 0xc4b08a, roughness: 1 });
    const bambooMat = new THREE.MeshStandardMaterial({ color: 0x72b040, roughness: 0.8 });
    const wreckMat = new THREE.MeshStandardMaterial({ color: 0x4b2f16, roughness: 1, map: null });
    const canvasMat = new THREE.MeshStandardMaterial({ color: 0xc9b57d, roughness: 0.96, side: THREE.DoubleSide });
    const shrineMat = new THREE.MeshStandardMaterial({ color: 0x625846, roughness: 1 });
    const coconutMat = new THREE.MeshStandardMaterial({ color: 0x3a5818, roughness: 0.95 });
    const flowerStemMat = new THREE.MeshStandardMaterial({ color: 0x2e6820, roughness: 1 });
    const flowerColors = [0xff4499, 0xff8030, 0xffe820, 0xff3322, 0xcc44ff, 0xff6699];
    const flowerMats = flowerColors.map((color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.12, roughness: 0.9 }));
    const palmFrondGeo = new THREE.PlaneGeometry(1, 1, 1, 2);
    const coconutGeo = new THREE.SphereGeometry(1, 6, 5);
    const boulderGeo = new THREE.DodecahedronGeometry(0.9, 0);
    const tuftGeo = new THREE.ConeGeometry(1, 1, 5);
    const fernLeafGeo = new THREE.PlaneGeometry(1, 1, 1, 2);
    const flowerStemGeo = new THREE.CylinderGeometry(0.016, 0.022, 1, 4);
    const flowerBloomGeo = new THREE.SphereGeometry(1, 6, 5);
    const bambooGeo = new THREE.CylinderGeometry(0.05, 0.075, 1, 5);

    const createLayer = (config: {
      topRadius: number;
      bottomRadius: number;
      height: number;
      y: number;
      material: THREE.Material;
      radialSegments?: number;
      heightSegments?: number;
      scaleX?: number;
      scaleZ?: number;
      massOffsetX?: number;
      massOffsetZ?: number;
      shelf?: number;
      cliff?: number;
      cap?: number;
      jagged?: number;
      lean?: number;
    }) => {
      const geometry = new THREE.CylinderGeometry(
        config.topRadius,
        config.bottomRadius,
        config.height,
        config.radialSegments ?? 24,
        config.heightSegments ?? 5,
      );
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const vertex = new THREE.Vector3();

      for (let index = 0; index < position.count; index++) {
        vertex.fromBufferAttribute(position, index);
        const angle = Math.atan2(vertex.z, vertex.x);
        const baseRadius = Math.hypot(vertex.x, vertex.z);
        const y01 = (vertex.y + config.height * 0.5) / config.height;
        const lobeA = Math.sin(angle * 2 + islandHeading + y01 * 0.7) * 0.14;
        const lobeB = Math.sin(angle * 3 - islandHeading * 1.8 + y01 * 1.9) * 0.09;
        const lobeC = Math.cos(angle * 5 + islandHeading * 0.6 - y01 * 2.7) * 0.04;
        const shelf = Math.exp(-Math.pow((y01 - 0.18) / 0.17, 2)) * (config.shelf ?? 0.08);
        const cliff = Math.pow(1 - y01, 1.35) * (config.cliff ?? 0.1);
        const cap = Math.pow(y01, 1.8) * (config.cap ?? 0.05);
        const asymmetry = Math.cos(angle - islandHeading) * 0.08 + Math.sin(angle * 0.5 + islandHeading * 0.7) * 0.04;
        const jagged = (
          Math.sin(angle * 11 + y01 * 9 + islandHeading) +
          Math.cos(angle * 17 - y01 * 12 + islandHeading * 0.4)
        ) * (config.jagged ?? 0.015);
        const radialScale = 1 + lobeA + lobeB + lobeC + shelf + cliff - cap + asymmetry + jagged;
        const drift = (y01 - 0.5) * (config.lean ?? 0.02) * config.height;
        if (baseRadius > 0.0001) {
          vertex.x = Math.cos(angle) * baseRadius * radialScale * (config.scaleX ?? 1) + (config.massOffsetX ?? 0) + Math.cos(islandHeading) * drift;
          vertex.z = Math.sin(angle) * baseRadius * radialScale * (config.scaleZ ?? 1) + (config.massOffsetZ ?? 0) + Math.sin(islandHeading) * drift;
          vertex.y += (lobeA * 0.06 + lobeB * 0.04) * config.height * (0.3 + y01);
        } else {
          vertex.x += (config.massOffsetX ?? 0);
          vertex.z += (config.massOffsetZ ?? 0);
        }
        position.setXYZ(index, vertex.x, vertex.y, vertex.z);
      }

      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, config.material);
      mesh.position.y = config.y;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    const surfacePoint = (distRatio: number, angle: number, extraY = 0) => {
      const point = getIslandSurfacePoint(island, distRatio, angle, extraY);
      return new THREE.Vector3(
        point.x - island.position.x,
        point.y,
        point.z - island.position.z,
      );
    };

    createLayer({
      topRadius: r * 1.02,
      bottomRadius: r * 1.26,
      height: r * 0.16,
      y: -r * 0.11,
      material: reefMat,
      radialSegments: 26,
      heightSegments: 5,
      scaleX: footprintX * 1.12,
      scaleZ: footprintZ * 1.12,
      shelf: 0.06,
      cliff: 0.03,
      cap: 0.005,
      jagged: 0.01,
      lean: 0.02,
    });

    const terrainPositions: number[] = [];
    const terrainColors: number[] = [];
    const terrainIndices: number[] = [];
    const radialSegments = 12;
    const angularSegments = 34;
    const terrainColor = new THREE.Color();
    const scratchColor = new THREE.Color();

    for (let ring = 0; ring <= radialSegments; ring++) {
      const distRatio = ring === 0 ? 0 : Math.pow(ring / radialSegments, 0.9);
      for (let segment = 0; segment <= angularSegments; segment++) {
        const angle = (segment / angularSegments) * Math.PI * 2;
        const point = surfacePoint(distRatio, angle, 0.02);
        terrainPositions.push(point.x, point.y, point.z);

        const heightNorm = THREE.MathUtils.clamp(point.y / Math.max(r * 0.18, 1), 0, 1);
        const shoreMask = THREE.MathUtils.smoothstep(distRatio, 0.72, 0.99);
        const grassMask = THREE.MathUtils.smoothstep(heightNorm, 0.06, 0.5)
          * (1 - THREE.MathUtils.smoothstep(distRatio, 0.78, 0.98));
        const jungleMask = THREE.MathUtils.smoothstep(heightNorm, 0.1, 0.44)
          * (1 - THREE.MathUtils.smoothstep(distRatio, 0.55, 0.82)) * 0.7;
        const rockMask = THREE.MathUtils.smoothstep(heightNorm, 0.6, 0.94) * (1 - shoreMask * 0.6);
        const peakMask = THREE.MathUtils.smoothstep(heightNorm, 0.86, 1) * 0.35;
        const mudMask = THREE.MathUtils.smoothstep(distRatio, 0.62, 0.78) * (1 - shoreMask) * 0.3;

        terrainColor.copy(sandColor);
        terrainColor.lerp(beachColor, shoreMask * 0.9);
        terrainColor.lerp(mudColor, mudMask);
        terrainColor.lerp(grassColor, grassMask * 0.9);
        terrainColor.lerp(jungleColor, jungleMask);
        terrainColor.lerp(cliffColor, rockMask * 0.6);
        terrainColor.lerp(peakColor, peakMask);
        scratchColor.copy(beachColor).multiplyScalar(THREE.MathUtils.smoothstep(distRatio, 0.9, 1) * 0.14);
        terrainColor.add(scratchColor);

        // Per-vertex noise for natural variation
        const vnoise = (rng(ring * 113 + segment * 17) - 0.5) * 0.035;
        terrainColors.push(
          THREE.MathUtils.clamp(terrainColor.r + vnoise * 0.5, 0, 1),
          THREE.MathUtils.clamp(terrainColor.g + vnoise, 0, 1),
          THREE.MathUtils.clamp(terrainColor.b + vnoise * 0.3, 0, 1),
        );
      }
    }

    for (let ring = 0; ring < radialSegments; ring++) {
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
    terrainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(terrainColors, 3));
    terrainGeometry.setIndex(terrainIndices);
    terrainGeometry.computeVertexNormals();

    const terrain = new THREE.Mesh(
      terrainGeometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, side: THREE.DoubleSide }),
    );
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    group.add(terrain);

    // Shore skirt closes the gap between the terrain cap and the underwater reef
    // so islands read as solid landforms instead of floating tops.
    const skirtPositions: number[] = [];
    const skirtColors: number[] = [];
    const skirtIndices: number[] = [];
    const skirtSegments = 44;
    const skirtBottomColor = new THREE.Color(0x5d5a50);
    for (let segment = 0; segment <= skirtSegments; segment++) {
      const angle = (segment / skirtSegments) * Math.PI * 2;
      const top = surfacePoint(0.978, angle, -0.08);
      const expand = 1.018 + (rng(segment * 313 + 11) - 0.5) * 0.02;
      const bottomY = -Math.max(3.4, r * 0.14) - rng(segment * 317 + 17) * Math.max(0.5, r * 0.022);
      skirtPositions.push(top.x, top.y, top.z);
      skirtPositions.push(top.x * expand, bottomY, top.z * expand);

      const topBlend = THREE.MathUtils.smoothstep(Math.abs(top.y) / Math.max(1, r * 0.2), 0.08, 0.7);
      const topColor = cliffColor.clone().lerp(mudColor, 0.24 + topBlend * 0.14);
      skirtColors.push(topColor.r, topColor.g, topColor.b);
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
    shoreSkirt.castShadow = true;
    shoreSkirt.receiveShadow = true;
    group.add(shoreSkirt);

    if (island.dock) {
      const dock = new THREE.Group();
      dock.position.set(
        island.dock.position.x - island.position.x,
        island.dock.position.y,
        island.dock.position.z - island.position.z,
      );
      dock.rotation.y = island.dock.rotation;

      const dockMat = new THREE.MeshStandardMaterial({ color: 0x7b5529, roughness: 0.95 });
      const beamMat = new THREE.MeshStandardMaterial({ color: 0x5e3d1d, roughness: 1 });
      const ropeMat = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
      const plankMats = [0x8d6230, 0x83592d, 0x976a35].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.96 }));

      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(island.dock.width, 0.22, island.dock.length),
        dockMat,
      );
      deck.position.y = 0.12;
      deck.castShadow = true;
      deck.receiveShadow = true;
      dock.add(deck);

      const shorePlatform = new THREE.Mesh(
        new THREE.BoxGeometry(island.dock.width * 1.2, 0.24, Math.min(4.6, island.dock.length * 0.3)),
        dockMat,
      );
      shorePlatform.position.set(0, 0.14, -island.dock.length * 0.34);
      shorePlatform.castShadow = true;
      shorePlatform.receiveShadow = true;
      dock.add(shorePlatform);

      const ladderZ = -island.dock.length * 0.46;
      const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95 });
      const rungMat = new THREE.MeshStandardMaterial({ color: 0x6a4828, roughness: 0.92 });
      const side = island.dock.width * 0.22;
      for (const sx of [-side, side] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.1), railMat);
        rail.position.set(sx, 0.72, ladderZ + 0.12);
        rail.castShadow = true;
        dock.add(rail);
      }
      const rungCount = 8;
      for (let r = 0; r < rungCount; r++) {
        const rung = new THREE.Mesh(new THREE.BoxGeometry(side * 2.1, 0.07, 0.12), rungMat);
        rung.position.set(0, 0.18 + r * 0.14, ladderZ + r * 0.04);
        rung.castShadow = true;
        dock.add(rung);
      }

      const plankCount = Math.max(5, Math.round(island.dock.width));
      for (let i = 0; i < plankCount; i++) {
        const plank = new THREE.Mesh(
          new THREE.BoxGeometry(island.dock.width / plankCount * 0.82, 0.04, island.dock.length * 0.96),
            plankMats[i % plankMats.length],
        );
        plank.position.set(
          -island.dock.width * 0.5 + (i + 0.5) * (island.dock.width / plankCount),
          0.25,
          0,
        );
        plank.castShadow = true;
        plank.receiveShadow = true;
        dock.add(plank);
      }

      for (const side of [-1, 1] as const) {
        for (let i = 0; i < 4; i++) {
          const z = -island.dock.length * 0.42 + i * (island.dock.length * 0.28);
          const postHeight = 1.35 + rng(i * 191 + side) * 0.4;
          const post = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, postHeight, 0.18),
            beamMat,
          );
          post.position.set(side * (island.dock.width * 0.45), postHeight * 0.45, z);
          post.castShadow = true;
          dock.add(post);

          if (i < 3) {
            const rail = new THREE.Mesh(
              new THREE.CylinderGeometry(0.035, 0.035, island.dock.length * 0.24, 6),
              ropeMat,
            );
            rail.rotation.z = Math.PI * 0.5;
            rail.position.set(side * (island.dock.width * 0.44), 0.88, z + island.dock.length * 0.14);
            dock.add(rail);
          }
        }
      }

      const bollard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.13, 0.55, 8),
        beamMat,
      );
      bollard.position.set(island.dock.moorSide * island.dock.width * 0.28, 0.26, island.dock.length * 0.18);
      bollard.castShadow = true;
      dock.add(bollard);

      // Lanterns at dock entrance posts
      const lanternMat = new THREE.MeshStandardMaterial({
        color: 0x8b6c2a,
        emissive: 0xffcc44,
        emissiveIntensity: 0.5,
        roughness: 0.9,
      });
      for (const lanternSide of [-1, 1] as const) {
        const lanternPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.8, 0.16), beamMat);
        lanternPost.position.set(lanternSide * (island.dock.width * 0.46), 0.9, -island.dock.length * 0.38);
        lanternPost.castShadow = true;
        dock.add(lanternPost);

        const lanternBox = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), lanternMat);
        lanternBox.position.set(lanternSide * (island.dock.width * 0.46), 1.95, -island.dock.length * 0.38);
        dock.add(lanternBox);

        if (lanternSide === 1) {
          const lanternGlow = new THREE.PointLight(0xffa840, 1.25, 16);
          lanternGlow.position.set(0, 2.0, -island.dock.length * 0.38);
          dock.add(lanternGlow);
        }
      }

      group.add(dock);
    }

    const boulderCount = Math.max(3, Math.round(r / 20));
    for (let i = 0; i < boulderCount; i++) {
      const angle = rng(i * 3) * Math.PI * 2;
      const distRatio = 0.5 + rng(i * 7) * 0.36;
      const scale = 0.7 + rng(i * 11) * 1.6;
      const boulder = new THREE.Mesh(boulderGeo, boulderMat);
      boulder.scale.set(
        scale * (0.85 + rng(i * 19) * 0.45),
        scale * (0.6 + rng(i * 23) * 0.55),
        scale * (0.8 + rng(i * 29) * 0.5),
      );
      boulder.position.copy(surfacePoint(distRatio, angle, boulder.scale.y * 0.34));
      boulder.rotation.set(rng(i * 31) * Math.PI, rng(i * 37) * Math.PI, rng(i * 41) * Math.PI);
      boulder.castShadow = true;
      boulder.receiveShadow = true;
      group.add(boulder);
    }

    const outcropCount = Math.max(2, Math.round(r / 34));
    for (let i = 0; i < outcropCount; i++) {
      const angle = islandHeading + i * ((Math.PI * 2) / outcropCount) + rng(i * 43) * 0.55;
      const distRatio = 0.62 + rng(i * 47) * 0.14;
      const outcrop = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18 + rng(i * 53) * 0.2, 0.34 + rng(i * 59) * 0.22, 0.85 + rng(i * 61) * 0.9, 6),
        cliffMat,
      );
      outcrop.position.copy(surfacePoint(distRatio, angle, outcrop.scale.y * 0.22));
      outcrop.rotation.set(rng(i * 67) * 0.2, rng(i * 71) * Math.PI * 2, (rng(i * 73) - 0.5) * 0.28);
      outcrop.scale.setScalar(0.9 + rng(i * 79) * 0.6);
      outcrop.castShadow = true;
      outcrop.receiveShadow = true;
      group.add(outcrop);
    }

    const palmCount = Math.max(2, Math.round(r / 24));
    for (let i = 0; i < palmCount; i++) {
      const angle = rng(i * 83) * Math.PI * 2;
      const distRatio = 0.18 + rng(i * 89) * 0.3;
      const palm = new THREE.Group();
      palm.position.copy(surfacePoint(distRatio, angle));

      const trunkH = 3.6 + rng(i * 97) * 2.1;
      const tiltZ = (rng(i * 101) - 0.5) * 0.28;
      const tiltX = (rng(i * 103) - 0.5) * 0.16;

      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.22, trunkH, 7),
        trunkMat,
      );
      trunk.rotation.set(tiltX, 0, tiltZ);
      trunk.position.y = trunkH * 0.5;
      trunk.castShadow = true;
      palm.add(trunk);

      const frondCount = 5 + Math.floor(rng(i * 107) * 2);
      for (let f = 0; f < frondCount; f++) {
        const frondAngle = (f / frondCount) * Math.PI * 2 + rng(f * 109 + i) * 0.4;
        const frondLen = 2.4 + rng(f * 113 + i) * 1.4;
        const frondW = 0.55 + rng(f * 127 + i) * 0.32;
        const frond = new THREE.Mesh(palmFrondGeo, frondMat);
        frond.scale.set(frondW, frondLen, 1);
        frond.position.set(
          Math.cos(frondAngle) * frondLen * 0.44,
          trunkH + frondLen * 0.16,
          Math.sin(frondAngle) * frondLen * 0.44,
        );
        frond.rotation.set(
          Math.PI * 0.28 + rng(f * 131 + i) * 0.2,
          frondAngle + Math.PI * 0.5,
          rng(f * 137 + i) * 0.15,
        );
        frond.castShadow = false;
        palm.add(frond);
      }

      // Coconut clusters near treetop
      const coconutCount = 2 + Math.floor(rng(i * 211) * 2);
      for (let c = 0; c < coconutCount; c++) {
        const cAngle = (c / coconutCount) * Math.PI * 2 + rng(c * 213 + i) * 0.8;
        const coconut = new THREE.Mesh(coconutGeo, coconutMat);
        coconut.scale.setScalar(0.15 + rng(c * 217 + i) * 0.05);
        coconut.position.set(
          Math.cos(cAngle) * (0.22 + rng(c * 219 + i) * 0.18),
          trunkH + 0.18 + rng(c * 223 + i) * 0.22,
          Math.sin(cAngle) * (0.22 + rng(c * 227 + i) * 0.18),
        );
        coconut.castShadow = false;
        palm.add(coconut);
      }

      group.add(palm);
    }

    const tuftCount = Math.max(4, Math.round(r / 18));
    for (let i = 0; i < tuftCount; i++) {
      const angle = rng(i * 139) * Math.PI * 2;
      const distRatio = rng(i * 149) * 0.42;
      const tuft = new THREE.Mesh(tuftGeo, tuftMat);
      tuft.scale.set(0.18 + rng(i * 151) * 0.22, 0.6 + rng(i * 157) * 0.55, 0.18 + rng(i * 151) * 0.22);
      tuft.position.copy(surfacePoint(distRatio, angle, 0.16));
      tuft.rotation.set(rng(i * 163) * 0.2, rng(i * 167) * Math.PI * 2, rng(i * 173) * 0.2);
      tuft.castShadow = false;
      group.add(tuft);
    }

    // Ferns in the jungle interior
    const fernCount = Math.max(2, Math.round(r / 24));
    for (let i = 0; i < fernCount; i++) {
      const angle = rng(i * 179) * Math.PI * 2;
      const distRatio = rng(i * 181) * 0.3;
      const fernPos = surfacePoint(distRatio, angle, 0.1);
      const fernGroup = new THREE.Group();
      fernGroup.position.copy(fernPos);
      const leafCount = 4 + Math.floor(rng(i * 183) * 2);
      for (let l = 0; l < leafCount; l++) {
        const leafAngle = (l / leafCount) * Math.PI * 2 + rng(l * 187 + i) * 0.55;
        const leafLen = 0.7 + rng(l * 189 + i) * 0.7;
        const leaf = new THREE.Mesh(fernLeafGeo, fernMat);
        leaf.scale.set(0.2 + rng(l * 191 + i) * 0.12, leafLen, 1);
        leaf.position.set(
          Math.cos(leafAngle) * leafLen * 0.28,
          leafLen * 0.18,
          Math.sin(leafAngle) * leafLen * 0.28,
        );
        leaf.rotation.set(-0.4 - rng(l * 193 + i) * 0.3, leafAngle + Math.PI * 0.5, 0);
        leaf.castShadow = false;
        fernGroup.add(leaf);
      }
      group.add(fernGroup);
    }

    // Tropical flowers scattered across the interior
    const flowerCount = Math.max(3, Math.round(r / 22));
    for (let i = 0; i < flowerCount; i++) {
      const angle = rng(i * 193) * Math.PI * 2;
      const distRatio = 0.04 + rng(i * 197) * 0.38;
      const flowerPos = surfacePoint(distRatio, angle, 0.06);
      const stemH = 0.22 + rng(i * 199) * 0.24;
      const flowerMat = flowerMats[Math.floor(rng(i * 201) * flowerMats.length)];
      const flowerGroup = new THREE.Group();
      flowerGroup.position.copy(flowerPos);

      const stem = new THREE.Mesh(flowerStemGeo, flowerStemMat);
      stem.position.y = stemH * 0.5;
      stem.scale.y = stemH;
      flowerGroup.add(stem);

      const bloom = new THREE.Mesh(flowerBloomGeo, flowerMat);
      bloom.scale.setScalar(0.07 + rng(i * 203) * 0.04);
      bloom.position.y = stemH + 0.04;
      bloom.castShadow = false;
      flowerGroup.add(bloom);
      group.add(flowerGroup);
    }

    // Driftwood on the beach
    const driftwoodCount = 1 + Math.floor(rng(islandSeed) * 3);
    for (let i = 0; i < driftwoodCount; i++) {
      const angle = rng(i * 223 + 7) * Math.PI * 2;
      const distRatio = 0.76 + rng(i * 229) * 0.16;
      const logPos = surfacePoint(distRatio, angle, 0.04);
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
      group.add(log);
    }

    // Bamboo clusters on larger islands
    if (r > 52) {
      const bambooClusters = 1 + Math.floor(rng(islandSeed * 3 + 1) * 2);
      for (let g = 0; g < bambooClusters; g++) {
        const clusterAngle = rng(g * 251) * Math.PI * 2;
        const clusterDist = 0.12 + rng(g * 257) * 0.22;
        const clusterCenter = surfacePoint(clusterDist, clusterAngle);
        const stalkCount = 3 + Math.floor(rng(g * 263) * 3);
        for (let b = 0; b < stalkCount; b++) {
          const bh = 3.2 + rng(g * 269 + b) * 2.8;
          const bamboo = new THREE.Mesh(bambooGeo, bambooMat);
          bamboo.position.set(
            clusterCenter.x + (rng(b * 271 + g) - 0.5) * 1.4,
            bh * 0.5 + clusterCenter.y,
            clusterCenter.z + (rng(b * 277 + g) - 0.5) * 1.4,
          );
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

    if (r > 50 && rng(islandSeed * 5 + 19) > 0.42) {
      const wreck = new THREE.Group();
      const wreckAngle = islandHeading + Math.PI * (0.55 + rng(islandSeed * 7) * 0.5);
      const wreckPos = surfacePoint(0.82 + rng(islandSeed * 11) * 0.08, wreckAngle, 0.12);
      wreck.position.copy(wreckPos);
      wreck.rotation.y = -wreckAngle + Math.PI * 0.5;

      const keel = new THREE.Mesh(new THREE.BoxGeometry(r * 0.12, 0.12, 0.42 + r * 0.025), wreckMat);
      keel.position.y = 0.08;
      keel.castShadow = true;
      wreck.add(keel);

      for (let rib = 0; rib < 5; rib++) {
        const z = -r * 0.06 + rib * (r * 0.03);
        for (const sx of [-1, 1] as const) {
          const frame = new THREE.Mesh(
            new THREE.BoxGeometry(0.09, 1.1 + rng(rib * 307) * 0.6, 0.1),
            wreckMat,
          );
          frame.position.set(sx * (0.34 + rib * 0.06), 0.46, z);
          frame.rotation.z = sx * (0.58 + rib * 0.04);
          frame.castShadow = true;
          wreck.add(frame);
        }
      }

      for (let plank = 0; plank < 6; plank++) {
        const loose = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.08, 1.1 + rng(plank * 311) * 0.9),
          wreckMat,
        );
        loose.position.set((rng(plank * 313) - 0.5) * 2.4, 0.14, (rng(plank * 317) - 0.5) * 2.2);
        loose.rotation.set(0.04, rng(plank * 331) * Math.PI * 2, (rng(plank * 337) - 0.5) * 0.18);
        loose.castShadow = true;
        wreck.add(loose);
      }

      const tornSail = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1, 1, 2), canvasMat);
      tornSail.position.set(-0.65, 0.62, -0.55);
      tornSail.rotation.set(-0.45, 0.2, -0.18);
      tornSail.castShadow = false;
      wreck.add(tornSail);

      group.add(wreck);
    }

    if (r > 58 && rng(islandSeed * 13 + 29) > 0.36) {
      const ruin = new THREE.Group();
      const ruinAngle = island.profile.primaryHillAngle + rng(islandSeed * 17) * 0.8;
      ruin.position.copy(surfacePoint(0.18 + rng(islandSeed * 23) * 0.18, ruinAngle, 0.02));
      ruin.rotation.y = rng(islandSeed * 31) * Math.PI * 2;

      for (let pillar = 0; pillar < 3; pillar++) {
        const angle = (pillar / 3) * Math.PI * 2;
        const height = 1.0 + rng(pillar * 347) * 1.2;
        const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, height, 7), shrineMat);
        stone.position.set(Math.cos(angle) * 0.9, height * 0.5, Math.sin(angle) * 0.7);
        stone.rotation.z = (rng(pillar * 349) - 0.5) * 0.18;
        stone.castShadow = true;
        ruin.add(stone);
      }

      const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.24, 0.34), shrineMat);
      lintel.position.set(0, 1.62, -0.12);
      lintel.rotation.z = (rng(islandSeed * 37) - 0.5) * 0.12;
      lintel.castShadow = true;
      ruin.add(lintel);

      const bowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.34, 0.16, 8),
        new THREE.MeshStandardMaterial({ color: 0x27231d, roughness: 0.9, emissive: 0x3a1e08, emissiveIntensity: 0.28 }),
      );
      bowl.position.set(0.18, 0.12, 0.34);
      ruin.add(bowl);

      group.add(ruin);
    }

    this.environment.add(group);
    this.islandMeshes.set(island.id, group);

    for (const chest of island.chests) {
      const chestGroup = new THREE.Group();
      chestGroup.position.set(chest.position.x, chest.position.y, chest.position.z);

      const surfaceY = getIslandSurfaceY(island, chest.position.x, chest.position.z);

      const chestMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.7, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.95 }),
      );
      chestMesh.castShadow = true;
      chestGroup.add(chestMesh);

      const lid = new THREE.Mesh(
        new THREE.BoxGeometry(1.08, 0.2, 0.75),
        new THREE.MeshStandardMaterial({ color: 0x8b5e2f, roughness: 0.9 }),
      );
      lid.position.y = 0.42;
      chestGroup.add(lid);

      const glow = new THREE.PointLight(0xffc75a, 1.2, 12);
      glow.position.set(0, 1.2, 0);
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

      this.environment.add(chestGroup);
      this.chestMeshes.set(chest.id, { root: chestGroup, glow, chestMesh, lid, mound });
    }

    for (const barrel of island.barrels) {
      const barrelRoot = new THREE.Group();
      barrelRoot.position.set(barrel.position.x, barrel.position.y, barrel.position.z);
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
      this.environment.add(barrelRoot);
      this.barrelMeshes.set(barrel.id, barrelRoot);
    }

    for (const station of island.upgradeStations) {
      const meta = this.getUpgradePresentation(station.type);
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

      this.environment.add(stationGroup);
      this.upgradeStationMeshes.set(station.id, {
        root: stationGroup,
        core,
        halo,
        sign,
        light,
        type: station.type,
      });
    }

    for (const npc of island.npcs ?? []) {
      const npcRecord = this.buildStoryNpcMesh(npc);
      this.environment.add(npcRecord.root);
      this.npcMeshes.set(npc.id, npcRecord);
    }
  }

  private buildStoryNpcMesh(npc: IslandNpc): NpcMeshRecord {
    const root = new THREE.Group();
    root.position.set(npc.position.x, npc.position.y, npc.position.z);

    const roleColor: Record<IslandNpc['role'], number> = {
      mysterious_stranger: 0x29364f,
      shipwright: 0x7b4a24,
      oracle: 0x3c4f37,
      gold_hoarder: 0x7a5a1c,
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
    };
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(1.1, 18),
      new THREE.MeshStandardMaterial({ color: rugColor[npc.role], roughness: 0.95, side: THREE.DoubleSide }),
    );
    rug.rotation.x = -Math.PI * 0.5;
    rug.position.y = 0.02;
    rug.receiveShadow = true;
    root.add(rug);

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
    } else {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.52, 0.58), propMat);
      crate.position.set(-0.82, 0.28, -0.2);
      crate.castShadow = true;
      root.add(crate);
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
    root.add(light);
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.26, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xd6a143, emissive: 0xff8a20, emissiveIntensity: 0.75, roughness: 0.7 }),
    );
    lantern.position.copy(light.position);
    root.add(lantern);

    return { root, body, light, baseY: npc.position.y, role: npc.role };
  }

  private frame(now: number) {
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.frameDt = dt;
    this.minimapTimer -= dt;
    this.inputSendTimer -= dt;

    this.ocean.update(dt, this.renderer.camera.position);
    this.updateScene(dt);

    const hasForcedInput = this.input.hasPendingActions() || this.pendingInteractFromUi || this.pendingLaunchFromUi;
    if (this.network.isConnected() && (this.inputSendTimer <= 0 || hasForcedInput)) {
      const input = this.input.buildInput();
      if (input.useWheelItem && input.wheelIndex !== null) {
        this.startPocketUsePreview(input.wheelIndex);
      }
      if (this.pendingInteractFromUi) {
        input.interact = true;
        this.pendingInteractFromUi = false;
      }
      input.interactIntent = input.interact
        ? (this.resolveCurrentInteractKind() ?? this.visibleInteractKind ?? this.lastInteractKind)
        : this.lastInteractKind;
      if (this.pendingLaunchFromUi) {
        input.jumpPressed = true;
        this.pendingLaunchFromUi = false;
      }
      this.network.sendInput(input);
      this.inputSendTimer = 1 / 60;
    }

    this.renderer.render();

    requestAnimationFrame((time) => this.frame(time));
  }

  private updateScene(dt: number) {
    if (!this.state) {
      return;
    }

    const snapshotAge = Math.min(0.22, (performance.now() - this.lastSnapshotAt) / 1000);
    this.shipRenderer.update(this.state.ships, this.state.players, this.ocean.getTime(), dt, snapshotAge, this.renderer.camera.position);
    this.syncSharks(dt);
    this.stormWall.rotation.y = this.ocean.getTime() * 0.035;
    this.stormWallTexture.offset.x = this.ocean.getTime() * 0.018;
    this.stormHalo.rotation.z = this.ocean.getTime() * 0.12;
    this.stormWeatherIntensity = this.computeStormWeatherIntensity();
    this.renderer.updateStormWeather(this.stormWeatherIntensity);
    this.ocean.setStormIntensity(this.stormWeatherIntensity);
    this.updateStormRainOverlay(dt, this.computeStormRainIntensity());
    this.updateStormLightningFlash(dt);
    const stormW = this.stormWeatherIntensity;
    const wallMat = this.stormWall.material as THREE.MeshBasicMaterial;
    wallMat.opacity = 0.18 + stormW * 0.28;
    wallMat.color.copy(this.stormWallColorClear).lerp(this.stormWallColorStorm, stormW);
    const haloMat = this.stormHalo.material as THREE.MeshBasicMaterial;
    haloMat.opacity = 0.08 + stormW * 0.16;
    this.combatFx.update(dt);
    this.syncKegs();
    this.slowSceneTimer -= dt;
    if (this.slowSceneTimer <= 0) {
      this.updateUpgradeStations(Math.max(dt, 0.1));
      this.updateStoryNpcs(Math.max(dt, 0.1));
      this.slowSceneTimer = 0.1;
    }
    this.syncPlayers(dt);
    this.syncProjectiles(dt);
    this.updateCamera();
    this.updateCombatHud(dt);
    this.syncLocalViewWeapon();
    this.updateWindWisps();
    this.updateLightning(dt);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.updateHud();
      this.hudTimer = 0.08;
    }
    if (this.minimapTimer <= 0) {
      this.drawMaps();
      this.minimapTimer = 0.25;
    }

    this.interactScanTimer -= dt;
    if (this.interactScanTimer <= 0) {
      this.refreshInteractIntentForNet();
      this.interactScanTimer = 1 / 30;
    }
  }

  /** Same look-based winner as the HUD; refreshed between input sends for prompt previews. */
  private refreshInteractIntentForNet() {
    this.lastInteractKind = this.resolveCurrentInteractKind();
  }

  private resolveCurrentInteractKind(): InteractIntent | null {
    if (!this.state) return null;
    const player = this.getLocalPlayer();
    if (!player) return null;
    const ship = this.getTrackedShip();
    const nearbyCannon = ship ? this.findNearbyCannonIndex(player, ship) : null;
    const repairSection = ship ? this.findRepairableHullSection(player, ship) : null;
    const lookInteraction = this.getLookInteraction(player, ship, nearbyCannon, repairSection);
    const canPickInteractKind = !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest
      && player.state !== 'respawning' && player.state !== 'eliminated';
    return canPickInteractKind && lookInteraction ? lookInteraction.kind : null;
  }

  /** Match server PhysicsSystem cannon flight between snapshots so launches don't feel ~1–3 ticks behind. */
  private extrapolateCannonBallistic(player: Player, ageSeconds: number) {
    let vx = player.velocity.x;
    let vy = player.velocity.y;
    let vz = player.velocity.z;
    let px = player.position.x;
    let py = player.position.y;
    let pz = player.position.z;
    const total = Math.max(0, Math.min(0.22, ageSeconds));
    const steps = Math.max(4, Math.ceil(total / 0.022));
    const step = total / steps;
    for (let i = 0; i < steps; i++) {
      vx *= Math.pow(PHYSICS.AIR_DRAG, step * 60);
      vz *= Math.pow(PHYSICS.AIR_DRAG, step * 60);
      vy += PHYSICS.GRAVITY * step;
      px += vx * step;
      py += vy * step;
      pz += vz * step;
    }
    return new THREE.Vector3(px, py, pz);
  }

  private getPlayerRenderPosition(player: Player, leadSeconds: number) {
    const isLocal = player.id === this.localPlayerId;
    const rawAge = (performance.now() - this.lastSnapshotAt) / 1000;
    const snapshotAge = Math.min(isLocal ? 0.24 : 0.18, rawAge);

    if (player.cannonBallistic) {
      const age = Math.min(0.22, snapshotAge + (isLocal ? leadSeconds + 0.02 : leadSeconds * 0.5));
      return this.extrapolateCannonBallistic(player, age);
    }

    let predictedX = player.position.x + (player.velocity.x + player.knockbackVelocity.x * 0.32) * leadSeconds;
    let predictedZ = player.position.z + (player.velocity.z + player.knockbackVelocity.z * 0.32) * leadSeconds;
    let visualY = player.position.y + (player.velocity.y + player.knockbackVelocity.y * 0.18) * leadSeconds;
    if (player.onShipId && this.state) {
      const ship = this.shipsById.get(player.onShipId) ?? null;
      if (ship) {
        const dx = player.position.x - ship.position.x;
        const dz = player.position.z - ship.position.z;
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        const localX = dx * cos - dz * sin;
        const localZ = dx * sin + dz * cos;
        const shipLead = Math.min(0.16, leadSeconds + snapshotAge * (isLocal ? 1 : 0.6));
        const predictedShipX = ship.position.x + ship.velocity.x * shipLead;
        const predictedShipZ = ship.position.z + ship.velocity.z * shipLead;
        const predictedShipRotation = ship.rotation + ship.angularVelocity * shipLead;
        const predictedCos = Math.cos(predictedShipRotation);
        const predictedSin = Math.sin(predictedShipRotation);
        predictedX = predictedShipX + localX * predictedCos + localZ * predictedSin
          + (player.velocity.x + player.knockbackVelocity.x * 0.32) * leadSeconds;
        predictedZ = predictedShipZ + localZ * predictedCos - localX * predictedSin
          + (player.velocity.z + player.knockbackVelocity.z * 0.32) * leadSeconds;
      }
    }
    // Lag compensation: extrapolate from last snapshot velocity only.
    // Do NOT add a second "input × speed × window" step on land or on ships — server velocity already
    // matches movement input each tick; duplicating it here caused rubber-banding (shuffle back/forth).
    if (isLocal && !player.atHelm && !player.atCannon && !player.atSails && !player.atCrowNest) {
      // On deck the server already couples you to the ship; full velocity×age extrapolation reads as double-counted lag.
      const deckDamp = player.onShipId ? 0.48 : 1;
      predictedX += player.velocity.x * snapshotAge * deckDamp;
      predictedZ += player.velocity.z * snapshotAge * deckDamp;
      visualY += player.velocity.y * snapshotAge * 0.3;
      const moveAxes = this.input.getMoveAxes();
      if (player.state !== 'swimming') {
        const moving = moveAxes.x !== 0 || moveAxes.z !== 0;
        const inputLead = Math.min(player.onShipId ? 0.07 : 0.12, snapshotAge + leadSeconds + 0.018);
        if (moving) {
          const len = Math.hypot(moveAxes.x, moveAxes.z) || 1;
          const nx = moveAxes.x / len;
          const nz = moveAxes.z / len;
          const yaw = this.input.getYaw();
          const desiredVx = (Math.sin(yaw) * nz - Math.cos(yaw) * nx) * PLAYER.MOVE_SPEED;
          const desiredVz = (Math.cos(yaw) * nz + Math.sin(yaw) * nx) * PLAYER.MOVE_SPEED;
          const response = player.onShipId ? 0.42 : 0.62;
          predictedX += (desiredVx - player.velocity.x) * inputLead * response;
          predictedZ += (desiredVz - player.velocity.z) * inputLead * response;
        } else {
          const stopLead = Math.min(player.onShipId ? 0.04 : 0.07, snapshotAge + leadSeconds);
          predictedX -= player.velocity.x * stopLead * 0.45;
          predictedZ -= player.velocity.z * stopLead * 0.45;
        }
      }
      if (player.state === 'swimming') {
        if (moveAxes.x !== 0 || moveAxes.z !== 0) {
          const yaw = this.input.getYaw();
          const pitch = this.input.getPitch();
          const len = Math.hypot(moveAxes.x, moveAxes.z) || 1;
          const nx = moveAxes.x / len;
          const nz = moveAxes.z / len;
          const predictionWindow = Math.min(0.22, snapshotAge + leadSeconds + 0.04);
          predictedX += (Math.sin(yaw) * nz - Math.cos(yaw) * nx) * PLAYER.SWIM_SPEED * predictionWindow * 1.05;
          predictedZ += (Math.cos(yaw) * nz + Math.sin(yaw) * nx) * PLAYER.SWIM_SPEED * predictionWindow * 1.05;
          visualY += Math.sin(pitch) * nz * PLAYER.SWIM_SPEED * predictionWindow * 0.72;
        }
      }
    }
    if (player.state === 'swimming') {
      const t = this.ocean.getTime();
      const waveY = gerstnerHeight(predictedX, predictedZ, t, WAVE_PARAMS);
      const waterSurface = waveY + 0.28;
      const targetFeetY = waterSurface - 0.18;
      const waveSnap = isLocal ? 0.88 : 0.82;
      visualY = THREE.MathUtils.lerp(visualY, targetFeetY, waveSnap);
    }
    // Match server: only treat as walkable island ground when inside the real footprint (not a huge ocean margin).
    // A loose margin here snapped feet to island height over the water past cliffs ("buffering" in mid-air).
    if (isLocal && !player.onShipId && this.state && player.state !== 'swimming') {
      let resolvedSurfaceY = -Infinity;
      for (const island of this.state.islands) {
        const rdx = predictedX - island.position.x;
        const rdz = predictedZ - island.position.z;
        const r2 = rdx * rdx + rdz * rdz;
        const islandReach = island.radius * 1.75 + 48;
        if (r2 > islandReach * islandReach) continue;

        if (isPointInsideIslandFootprint(island, predictedX, predictedZ, 1.0)) {
          resolvedSurfaceY = Math.max(resolvedSurfaceY, getIslandSurfaceY(island, predictedX, predictedZ) + 0.03);
        }
        if (island.dock) {
          const dx = predictedX - island.dock.position.x;
          const dz = predictedZ - island.dock.position.z;
          const cos = Math.cos(island.dock.rotation);
          const sin = Math.sin(island.dock.rotation);
          const localX = dx * cos - dz * sin;
          const localZ = dx * sin + dz * cos;
          if (Math.abs(localX) <= island.dock.width * 0.5 + 0.45 && Math.abs(localZ) <= island.dock.length * 0.5 + 0.45) {
            resolvedSurfaceY = Math.max(resolvedSurfaceY, island.dock.position.y + 0.14);
          }
        }
      }
      if (resolvedSurfaceY > -Infinity) {
        const clippedUnderTerrain = player.position.y < resolvedSurfaceY - 0.75;
        const settlingOntoGround =
          player.velocity.y <= 0.12
          && player.position.y <= resolvedSurfaceY + 0.22
          && player.position.y >= resolvedSurfaceY - 0.55;
        if (clippedUnderTerrain || settlingOntoGround) {
          const snap = clippedUnderTerrain ? 1 : 0.58;
          visualY = THREE.MathUtils.lerp(visualY, resolvedSurfaceY, snap);
        }
      }
    }
    return new THREE.Vector3(predictedX, visualY, predictedZ);
  }

  private syncPlayers(dt: number) {
    if (!this.state) return;

    for (const [playerId, mesh] of this.playerMeshes) {
      if (!this.livePlayerIds.has(playerId)) {
        this.renderer.scene.remove(mesh);
        this.playerMeshes.delete(playerId);
      }
    }

    for (const player of this.state.players) {
      let mesh = this.playerMeshes.get(player.id);
      if (!mesh) {
        const isSkeleton = player.isBot && player.shipId === null;
        mesh = makePlayerMesh(
          isSkeleton ? 0xd7d1c4 : player.id === this.localPlayerId ? 0x6f2d22 : player.isBot ? 0x9a3340 : 0x365879,
          isSkeleton ? 'skeleton' : 'pirate',
          player.id === this.localPlayerId ? 'captain' : player.isBot ? 'crew' : 'raider',
        );
        this.playerMeshes.set(player.id, mesh);
        this.renderer.scene.add(mesh);
      }

      const isLocal = player.id === this.localPlayerId;
      const ship = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
      const hideForLocalAim = isLocal;
      const useLocalSwimViewmodel = false;

      const targetPos = this.getPlayerRenderPosition(player, isLocal ? (player.state === 'swimming' ? 0.05 : player.cannonBallistic ? 0.06 : 0.055) : player.cannonBallistic ? 0.05 : 0.035);
      const onIslandFoot = !player.onShipId && player.state === 'alive';
      const movementKey = `${player.state}|${player.onShipId ?? 'off'}|${onIslandFoot ? 'isle' : 'open'}|${player.cannonBallistic ? 'bal' : 'nb'}`;
      const ud = mesh.userData as { movementKey?: string; transitionBoost?: number };
      if (ud.movementKey !== movementKey) {
        ud.movementKey = movementKey;
        ud.transitionBoost = 0.38;
      }
      if (ud.transitionBoost && ud.transitionBoost > 0) {
        ud.transitionBoost = Math.max(0, ud.transitionBoost - dt * 2.8);
      }
      const boost = isLocal && (ud.transitionBoost ?? 0) > 0 ? (ud.transitionBoost ?? 0) * 88 : 0;
      const basePosRate = isLocal
        ? (player.cannonBallistic
          ? 165
          : onIslandFoot
            ? 82
            : player.onShipId && player.state === 'alive'
              ? 76
              : player.state === 'swimming'
                ? 128
                : 64)
        : (player.cannonBallistic ? 120 : onIslandFoot ? 38 : player.state === 'swimming' ? 72 : 32);
      const positionAlpha = 1 - Math.exp(-(basePosRate + boost) * dt);
      const rotationAlpha = 1 - Math.exp(-18 * dt);
      const targetYaw = player.atHelm && ship
        ? ship.rotation
        : isLocal
          ? this.input.getYaw()
          : player.rotation.x;
      const isSkeleton = mesh.userData.animation?.variant === 'skeleton';
      const lastState = mesh.userData.lastState as Player['state'] | undefined;
      if (isSkeleton && lastState !== 'eliminated' && player.state === 'eliminated') {
        mesh.userData.deathTimer = 0;
        mesh.userData.deathSpin = Math.random() > 0.5 ? 1 : -1;
      }
      mesh.userData.lastState = player.state;
      if (isSkeleton && player.state === 'eliminated') {
        mesh.userData.deathTimer = Math.min((mesh.userData.deathTimer ?? 0) + dt, 1.8);
      }

      const skeletonDeathVisible = isSkeleton && player.state === 'eliminated' && (mesh.userData.deathTimer ?? 0) < 1.55;
      mesh.visible = !isLocal && !useLocalSwimViewmodel && (skeletonDeathVisible || (player.state !== 'eliminated' && player.state !== 'respawning'));
      if (!mesh.userData.initialized) {
        mesh.position.copy(targetPos);
        mesh.rotation.y = targetYaw;
        mesh.rotation.x = 0;
        mesh.rotation.z = 0;
        mesh.userData.initialized = true;
      } else {
        mesh.position.lerp(targetPos, positionAlpha);
        mesh.rotation.y += angleWrap(targetYaw - mesh.rotation.y) * (isLocal ? 1 : rotationAlpha);
      }

      const healthBar = mesh.userData.healthBar as {
        root: THREE.Group;
        fill: THREE.Mesh;
        fullWidth: number;
      } | undefined;
      if (healthBar) {
        const distanceToCamera = mesh.position.distanceTo(this.renderer.camera.position);
        const showHealthBar =
          !isLocal
          && mesh.visible
          && player.state !== 'eliminated'
          && player.state !== 'respawning'
          && distanceToCamera < 90;
        healthBar.root.visible = showHealthBar;
        if (showHealthBar) {
          const ratio = THREE.MathUtils.clamp(player.health / PLAYER.MAX_HEALTH, 0, 1);
          healthBar.root.position.y = player.state === 'swimming' ? 1.55 : 2.38;
          this.tempHudVector.copy(this.renderer.camera.position);
          mesh.worldToLocal(this.tempHudVector);
          healthBar.root.lookAt(this.tempHudVector);
          healthBar.fill.scale.x = Math.max(0.001, ratio);
          healthBar.fill.position.x = -(healthBar.fullWidth * 0.5) + (healthBar.fullWidth * ratio) * 0.5;
          const fillMat = healthBar.fill.material as THREE.MeshBasicMaterial;
          fillMat.color.setHSL(0.02 + ratio * 0.31, 0.82, 0.56);
          fillMat.opacity = 0.68 + ratio * 0.28;
        }
      }

      const head = mesh.getObjectByName('head');
      const hair = mesh.getObjectByName('hair');
      const bandana = mesh.getObjectByName('bandana');
      const animParts = (mesh.userData.animation?.parts ?? {}) as Record<string, THREE.Object3D | undefined>;
      const torso = animParts.torso;
      const shirt = animParts.shirt;
      const coatSkirt = animParts.coatSkirt ?? animParts['coat-skirt'];
      const leftArmPivot = animParts.leftArmPivot ?? animParts['left-arm-pivot'];
      const showHead = (!isLocal || !this.input.isAiming()) && !hideForLocalAim;
      if (head) head.visible = showHead;
      if (hair) hair.visible = showHead && !isSkeleton;
      if (bandana) bandana.visible = showHead && !isSkeleton;
      if (torso) torso.visible = !isSkeleton && !hideForLocalAim;
      if (shirt) shirt.visible = !isSkeleton && !hideForLocalAim;
      if (coatSkirt) coatSkirt.visible = !isSkeleton && !hideForLocalAim;
      if (leftArmPivot) leftArmPivot.visible = !hideForLocalAim;

      if (player.state === 'swimming') {
        const swimBodyPitch = THREE.MathUtils.clamp(-Math.PI * 0.56 + player.rotation.y * 0.7, -1.18, -0.18);
        mesh.rotation.x += (swimBodyPitch - mesh.rotation.x) * Math.min(1, dt * 14);
        mesh.rotation.z += (0 - mesh.rotation.z) * Math.min(1, dt * 10);
      } else if (skeletonDeathVisible) {
        const deathProgress = Math.min(1, (mesh.userData.deathTimer ?? 0) / 0.75);
        const deathSpin = mesh.userData.deathSpin ?? 1;
        mesh.rotation.x += (-0.95 - mesh.rotation.x) * Math.min(1, dt * 12);
        mesh.rotation.z += (deathSpin * 0.85 - mesh.rotation.z) * Math.min(1, dt * 10);
        mesh.position.y -= deathProgress * dt * 0.35;
      } else {
        mesh.rotation.x += (0 - mesh.rotation.x) * Math.min(1, dt * 12);
        mesh.rotation.z += (0 - mesh.rotation.z) * Math.min(1, dt * 10);
      }

      if (skeletonDeathVisible) {
        this.animateSkeletonDeath(mesh);
      } else {
        this.animatePlayerMesh(mesh, player, ship, dt);
      }
      this.syncHeldWeapon(mesh, player);
    }
  }

  private syncProjectiles(dt: number) {
    if (!this.state) return;

    for (const [projectileId, mesh] of this.projectileMeshes) {
      if (!this.liveProjectileIds.has(projectileId)) {
        const projectileType = mesh.userData.projectileType as Projectile['type'] | undefined;
        const showImpact = mesh.userData.showImpact as boolean | undefined;
        if (projectileType && showImpact !== false) {
          this.combatFx.emitImpact(
            projectileType,
            { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
            this.renderer.camera.position,
          );
        }
        this.renderer.scene.remove(mesh);
        this.projectileMeshes.delete(projectileId);
      }
    }

    for (const projectile of this.state.projectiles) {
      if (!projectile.alive) continue;
      let mesh = this.projectileMeshes.get(projectile.id);
      if (!mesh) {
        mesh = makeProjectileMesh(projectile);
        this.projectileMeshes.set(projectile.id, mesh);
        this.renderer.scene.add(mesh);
        mesh.position.set(projectile.position.x, projectile.position.y, projectile.position.z);
        mesh.userData.projectileType = projectile.type;
        mesh.userData.showImpact = projectile.showImpact;
        this.combatFx.emitLaunch(projectile, this.renderer.camera.position, projectile.ownerId === this.localPlayerId);
      }
      mesh.userData.projectileType = projectile.type;
      mesh.userData.showImpact = projectile.showImpact;
      mesh.position.lerp(
        this.tempProjectilePos.set(projectile.position.x, projectile.position.y, projectile.position.z),
        1 - Math.exp(-24 * dt),
      );
    }
  }

  private syncKegs() {
    if (!this.state) return;

    for (const [kegId, mesh] of this.kegMeshes) {
      if (!this.liveKegIds.has(kegId)) {
        this.renderer.scene.remove(mesh.root);
        this.kegMeshes.delete(kegId);
      }
    }

    for (const keg of this.state.kegs) {
      if (keg.timer <= 0) continue;
      let mesh = this.kegMeshes.get(keg.id);
      if (!mesh) {
        const root = new THREE.Group();
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.26, 0.58, 10),
          new THREE.MeshStandardMaterial({ color: 0x5a3418, roughness: 0.92 }),
        );
        barrel.castShadow = true;
        root.add(barrel);

        const bandMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.45, metalness: 0.85 });
        for (const y of [-0.18, 0.18]) {
          const band = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 6, 10), bandMat);
          band.rotation.x = Math.PI * 0.5;
          band.position.y = y;
          root.add(band);
        }

        const fuseStem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.018, 0.22, 6),
          new THREE.MeshStandardMaterial({ color: 0x2b1f12, roughness: 1 }),
        );
        fuseStem.position.set(0.04, 0.36, 0);
        root.add(fuseStem);

        const fuse = new THREE.PointLight(0xff7a26, 1.2, 3.5);
        fuse.position.set(0.04, 0.48, 0);
        root.add(fuse);

        this.renderer.scene.add(root);
        mesh = { root, fuse };
        this.kegMeshes.set(keg.id, mesh);
      }

      mesh.root.position.set(keg.position.x, keg.position.y + 0.28, keg.position.z);
      const hostShip = this.shipsById.get(keg.shipId) ?? null;
      mesh.root.rotation.y = hostShip?.rotation ?? 0;
      mesh.fuse.intensity = 0.6 + Math.max(0.2, Math.sin((SHIP.KEG_FUSE_TIME - keg.timer) * 12) * 0.35 + (1 - Math.min(1, keg.timer / SHIP.KEG_FUSE_TIME)) * 2.1);
    }
  }

  private syncChests() {
    if (!this.state) return;

    for (const island of this.state.islands) {
      for (const chest of island.chests) {
        const chestMesh = this.chestMeshes.get(chest.id);
        if (!chestMesh) continue;
        chestMesh.root.position.set(chest.position.x, chest.position.y, chest.position.z);
        chestMesh.root.visible = !chest.opened;
        const portable = !!chest.carriedByPlayerId || !!chest.storedOnShipId || chest.floating;
        const dug = portable || chest.digProgress >= 1;
        if (chest.buried && chestMesh.mound) {
          chestMesh.mound.visible = !chest.opened && !portable && !dug;
          const s = Math.max(0.06, 1 - chest.digProgress * 0.95);
          chestMesh.mound.scale.setScalar(s);
        }
        chestMesh.chestMesh.visible = !chest.opened && (!chest.buried || dug);
        chestMesh.lid.visible = chestMesh.chestMesh.visible;
        chestMesh.glow.visible = !chest.opened && (dug || !chest.buried);
        chestMesh.glow.intensity = chest.floating ? 1.45 : chest.carriedByPlayerId ? 1.15 : 0.9;
        if (chestMesh.chestMesh.visible) {
          chestMesh.glow.position.set(0, 1.2, 0);
        }
      }
    }
  }

  private syncBarrels() {
    if (!this.state) return;
    for (const island of this.state.islands) {
      for (const barrel of island.barrels) {
        const root = this.barrelMeshes.get(barrel.id);
        if (!root) continue;
        root.visible = !barrel.opened;
      }
    }
  }

  private syncSharks(_dt: number) {
    if (!this.state) return;
    const sharks = this.state.sharks ?? [];
    const seen = new Set<string>();
    for (const shark of sharks) {
      if (shark.health <= 0) continue;
      seen.add(shark.id);
      let mesh = this.sharkMeshes.get(shark.id);
      if (!mesh) {
        mesh = this.buildSharkMesh();
        this.environment.add(mesh);
        this.sharkMeshes.set(shark.id, mesh);
      }
      mesh.position.set(shark.position.x, shark.position.y + 0.15, shark.position.z);
      mesh.rotation.y = shark.rotation;
    }
    for (const [id, mesh] of this.sharkMeshes) {
      if (!seen.has(id)) {
        this.combatFx.emitSharkDeathBloom(
          { x: mesh.position.x, y: mesh.position.y - 0.12, z: mesh.position.z },
          this.renderer.camera.position,
        );
        this.environment.remove(mesh);
        this.sharkMeshes.delete(id);
      }
    }
  }

  private buildSharkMesh(): THREE.Group {
    const g = new THREE.Group();
    const topMat = new THREE.MeshStandardMaterial({ color: 0x2a4a5c, roughness: 0.82, metalness: 0.08 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0x8aa8b8, roughness: 0.75, metalness: 0.02 });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x3a5c6e, roughness: 0.78, metalness: 0.05 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.48, 14, 12), topMat);
    body.scale.set(1.15, 0.72, 2.35);
    body.rotation.y = Math.PI * 0.5;
    body.position.y = 0.08;
    body.castShadow = true;
    g.add(body);

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), bellyMat);
    belly.scale.set(0.95, 0.55, 2.0);
    belly.rotation.y = Math.PI * 0.5;
    belly.position.set(0, -0.12, 0);
    g.add(belly);

    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.95, 10), topMat);
    snout.rotation.z = -Math.PI * 0.5;
    snout.position.set(1.12, 0.02, 0);
    snout.castShadow = true;
    g.add(snout);

    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.62, 8), finMat);
    tail.rotation.z = Math.PI * 0.5;
    tail.position.set(-1.05, 0.12, 0);
    tail.castShadow = true;
    g.add(tail);

    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.62, 6), finMat);
    dorsal.position.set(0.05, 0.52, 0);
    dorsal.rotation.z = Math.PI * 0.5;
    g.add(dorsal);

    const pecL = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.38), finMat);
    pecL.position.set(0.35, -0.18, 0.42);
    pecL.rotation.set(0.2, 0, 0.35);
    g.add(pecL);
    const pecR = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.38), finMat);
    pecR.position.set(0.35, -0.18, -0.42);
    pecR.rotation.set(0.2, 0, -0.35);
    g.add(pecR);

    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.3 }));
    eyeL.position.set(0.82, 0.18, 0.16);
    g.add(eyeL);
    const eyeR = eyeL.clone();
    eyeR.position.z = -0.16;
    g.add(eyeR);

    return g;
  }

  private updateUpgradeStations(dt: number) {
    if (!this.state) return;

    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const mesh = this.upgradeStationMeshes.get(station.id);
        if (!mesh) continue;

        const meta = this.getUpgradePresentation(mesh.type);
        const claimed = station.claimedByShipId !== null;
        const pulse = 0.75 + Math.sin(this.ocean.getTime() * 4 + mesh.root.position.x * 0.02) * 0.18;
        const glowOpacity = claimed ? 0.18 : 0.55 + Math.sin(this.ocean.getTime() * 3.2 + mesh.root.position.z * 0.03) * 0.12;
        mesh.halo.rotation.z += dt * (claimed ? 0.1 : 0.55);
        mesh.halo.position.y = 0.58 + (claimed ? 0 : Math.sin(this.ocean.getTime() * 2.8 + mesh.root.position.x * 0.01) * 0.05);
        mesh.light.intensity = claimed ? 0.18 : 2.1 * pulse;
        mesh.light.distance = claimed ? 10 : 16;

        const coreMaterial = mesh.core.material as THREE.MeshStandardMaterial;
        coreMaterial.color.setHex(claimed ? 0x8b8f97 : meta.hex);
        coreMaterial.emissive.setHex(claimed ? 0x31343a : meta.hex);
        coreMaterial.emissiveIntensity = claimed ? 0.14 : 0.78 * pulse;

        const haloMaterial = mesh.halo.material as THREE.MeshBasicMaterial;
        haloMaterial.color.setHex(claimed ? 0x8b8f97 : meta.hex);
        haloMaterial.opacity = glowOpacity;

        mesh.sign.lookAt(this.renderer.camera.position);
        const signMaterial = mesh.sign.material as THREE.MeshBasicMaterial;
        signMaterial.opacity = claimed ? 0.46 : 0.94;
      }
    }
  }

  private updateStoryNpcs(dt: number) {
    if (!this.state) return;

    const player = this.getLocalPlayer();
    const now = performance.now();
    if (this.storyCutscene && now > this.storyCutsceneHideAt) {
      this.storyCutscene.root.style.opacity = '0';
      this.storyCutscene.root.style.transform = 'translateY(14px)';
      this.storyCutsceneNpcId = null;
    }

    for (const island of this.state.islands) {
      for (const npc of island.npcs ?? []) {
        const mesh = this.npcMeshes.get(npc.id);
        if (!mesh) continue;

        const pulse = 0.82 + Math.sin(this.ocean.getTime() * 2.1 + mesh.root.position.x * 0.03) * 0.18;
        mesh.root.position.y = mesh.baseY + Math.sin(this.ocean.getTime() * 0.86 + mesh.root.position.z * 0.02) * 0.025;
        mesh.light.intensity = 1.0 + pulse * 0.65;

        if (!player || player.state === 'eliminated' || player.state === 'respawning') continue;

        const dx = player.position.x - mesh.root.position.x;
        const dz = player.position.z - mesh.root.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance < 11) {
          const desiredYaw = Math.atan2(dx, dz);
          mesh.body.rotation.y += angleWrap(desiredYaw - mesh.body.rotation.y) * Math.min(1, dt * 5.5);
        } else {
          mesh.body.rotation.y += angleWrap(npc.rotation - mesh.body.rotation.y) * Math.min(1, dt * 1.4);
        }

        if (
          distance < 7.2
          && !this.seenStoryNpcIds.has(npc.id)
          && this.storyCutsceneNpcId !== npc.id
        ) {
          this.triggerStoryCutscene(npc, island);
        }
      }
    }
  }

  private triggerStoryCutscene(npc: IslandNpc, island: Island) {
    if (!this.storyCutscene) return;
    this.seenStoryNpcIds.add(npc.id);
    this.storyCutsceneNpcId = npc.id;
    this.storyCutsceneHideAt = performance.now() + 6200;
    this.storyCutscene.title.textContent = npc.cutsceneTitle;
    this.storyCutscene.name.textContent = `${npc.name} - ${island.name}`;
    this.storyCutscene.line.textContent = npc.line;
    this.storyCutscene.cue.textContent = npc.cue;
    this.storyCutscene.root.style.opacity = '1';
    this.storyCutscene.root.style.transform = 'translateY(0)';
    this.pushFeed(`${npc.name}: ${npc.cue}`, '#f0d08a');
  }

  private updateStormRing() {
    if (!this.state) return;

    const segments = this.stormRingPositions.length / 3;
    const safeRadius = Math.max(16, this.state.storm.safeRadius);
    for (let index = 0; index < segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const offset = index * 3;
      this.stormRingPositions[offset] = this.state.storm.centerX + Math.cos(angle) * safeRadius;
      this.stormRingPositions[offset + 1] = 0;
      this.stormRingPositions[offset + 2] = this.state.storm.centerZ + Math.sin(angle) * safeRadius;
    }
    const positionAttr = this.stormRing.geometry.getAttribute('position') as THREE.BufferAttribute;
    positionAttr.needsUpdate = true;
    this.stormRing.material.opacity = 0.42 + Math.sin(this.ocean.getTime() * 3.6) * 0.08;

    this.stormWall.position.set(this.state.storm.centerX, 44, this.state.storm.centerZ);
    this.stormWall.scale.set(safeRadius, 1, safeRadius);
    this.stormWall.visible = true;

    this.stormHalo.position.set(this.state.storm.centerX, 9, this.state.storm.centerZ);
    this.stormHalo.scale.set(safeRadius, safeRadius, 1);
    this.stormHalo.visible = true;
  }

  private updateCamera() {
    const player = this.getLocalPlayer();
    if (!player) return;

    const trackedShip = player.onShipId ? this.getTrackedShip() : null;
    const activeWeapon = player.atCannon || player.atHelm || player.atSails || player.atCrowNest ? null : player.weapons[player.activeSlot];
    const swimming = player.state === 'swimming';
    const firearmEquipped = !!activeWeapon && !WEAPONS[activeWeapon.weaponId].melee;
    const aiming = this.input.isAiming();
    const firing = this.input.isFiring();
    const aimingFirearm = firearmEquipped && (aiming || firing);
    const scopedFov = aiming && activeWeapon && WEAPONS[activeWeapon.weaponId].scopeFov
      ? WEAPONS[activeWeapon.weaponId].scopeFov
      : null;

    let desired: THREE.Vector3;
    let lookTarget: THREE.Vector3;
    let targetFov = scopedFov ?? (aimingFirearm ? 64 : swimming ? 78 : 74);

    if (player.atCannon && trackedShip) {
      const aim = this.getCannonAim(trackedShip, player.cannonIndex, this.input.getYaw(), this.input.getPitch());
      const forward = new THREE.Vector3(
        Math.sin(aim.yaw) * Math.cos(aim.pitch),
        Math.sin(aim.pitch),
        Math.cos(aim.yaw) * Math.cos(aim.pitch),
      ).normalize();
      const cannonWorld = this.shipRenderer.getCannonWorldPos(trackedShip.id, player.cannonIndex)
        ?? this.getShipWorldPoint(
          trackedShip,
          this.getCannonSide(player.cannonIndex, trackedShip) * (SHIP_STATS[trackedShip.type].width * 0.52),
          0,
          SHIP_STATS[trackedShip.type].height + 0.18,
        );
      const inward = new THREE.Vector3(trackedShip.position.x, cannonWorld.y, trackedShip.position.z)
        .sub(cannonWorld)
        .normalize();
      desired = cannonWorld
        .clone()
        .addScaledVector(forward, -0.45)
        .addScaledVector(inward, 1.72)
        .add(new THREE.Vector3(0, 1.08, 0));
      lookTarget = cannonWorld.clone().addScaledVector(forward, 74).add(new THREE.Vector3(0, 0.44, 0));
      targetFov = 80;
    } else if (player.atSails && trackedShip) {
      const stats = SHIP_STATS[trackedShip.type];
      const station = this.getSailControlLocal(stats);
      const stationWorld = this.getShipWorldPoint(trackedShip, station.x, station.z, stats.height + 0.82);
      const sailTarget = this.getShipWorldPoint(
        trackedShip,
        0,
        getMainMastLocalZ(stats),
        stats.height + stats.height * 1.95,
      );
      const aftBias = this.getShipWorldPoint(
        trackedShip,
        0,
        station.z - stats.length * 0.11,
        stats.height + 0.86,
      );
      desired = stationWorld.lerp(aftBias, 0.22);
      lookTarget = sailTarget;
      targetFov = 76;
    } else {
      const yaw = player.atHelm && trackedShip ? trackedShip.rotation : this.input.getYaw();
      const pitch = this.input.getPitch();
      const forward = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ).normalize();
      const eyePos = this.getPlayerRenderPosition(player, 0.02).add(new THREE.Vector3(0, swimming ? PLAYER.HEIGHT * 0.56 : PLAYER.HEIGHT * 0.84, 0));
      desired = eyePos;
      lookTarget = eyePos
        .clone()
        .addScaledVector(forward, scopedFov ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14)
        .add(new THREE.Vector3(0, swimming ? -0.04 : scopedFov ? 0.05 : 0, 0));
    }

    const onIslandFoot = !player.onShipId && player.state === 'alive' && !swimming
      && !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest;
    let followHz = 158;
    if (player.atCannon || player.atHelm || player.atSails) followHz = 70;
    else if (onIslandFoot) followHz = 178;
    else if (swimming) followHz = 162;
    else if (player.onShipId) followHz = 165;
    const cameraFollow = 1 - Math.exp(-followHz * this.frameDt);
    this.renderer.camera.position.lerp(desired, cameraFollow);
    this.renderer.camera.lookAt(lookTarget);
    if (Math.abs(this.renderer.camera.fov - targetFov) > 0.05) {
      this.renderer.camera.fov += (targetFov - this.renderer.camera.fov) * Math.min(1, this.frameDt * 10);
      this.renderer.camera.updateProjectionMatrix();
    }
  }

  private getBlunderbussCrosshairSize(player: Player) {
    const spreadMultiplier = this.getLocalSpreadMultiplier(player, 'blunderbuss', this.input.isAiming());
    const spreadRad = THREE.MathUtils.degToRad(WEAPONS.blunderbuss.spread * spreadMultiplier);
    const fovRad = THREE.MathUtils.degToRad(this.renderer.camera.fov * 0.5);
    const radiusPx = Math.tan(spreadRad) / Math.max(0.001, Math.tan(fovRad)) * window.innerHeight * 0.5;
    const maxSize = Math.min(window.innerWidth * 0.76, window.innerHeight * 0.74);
    return Math.round(THREE.MathUtils.clamp(radiusPx * 2, 58, maxSize));
  }

  private getLocalSpreadMultiplier(player: Player, weaponId: WeaponId, aiming: boolean) {
    const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    let multiplier = 1;

    if (aiming) {
      multiplier *= weaponId === 'eye_of_reach' ? 0.12 : 0.55;
    } else if (weaponId === 'eye_of_reach') {
      multiplier *= 0.38;
    }

    if (player.state === 'swimming') {
      multiplier *= 1.7;
    } else if (moveSpeed > 0.1) {
      multiplier *= 1.35;
    } else {
      multiplier *= 0.92;
    }

    if (weaponId === 'blunderbuss') {
      multiplier *= aiming ? 0.82 : 1.08;
    }

    return multiplier;
  }

  private formatCompassHeading(angle: number): string {
    const headings = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const degrees = ((THREE.MathUtils.radToDeg(angle) % 360) + 360) % 360;
    return headings[Math.round(degrees / 45) % headings.length];
  }

  private updateHud() {
    if (!this.state) return;

    const player = this.getLocalPlayer();
    const ship = this.getTrackedShip();
    if (!player) return;

    this.ui.stormPhase.textContent = `STORM PHASE ${this.state.storm.phase + 1}`;
    const timerSeconds = this.state.storm.shrinking
      ? Math.max(0, Math.ceil((1 - this.state.storm.shrinkProgress) * this.state.storm.shrinkDuration))
      : Math.max(0, Math.ceil(this.state.storm.shrinkTimer));
    this.ui.stormTimer.textContent = `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')}`;
    this.ui.mapSubtitle.textContent = this.state.storm.shrinking
      ? `Storm moving now · closes in ${timerSeconds}s`
      : `Next storm shift in ${timerSeconds}s`;

    const outsideStorm = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ) > this.state.storm.safeRadius;
    const avgHull = ship
      ? (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4
      : 1;
    const shipCritical = !!ship && (ship.sinking || avgHull < 0.2);
    const shipOnFire = !!ship && ship.onFire && !ship.sinking;
    this.ui.stormWarning.style.display = outsideStorm || shipCritical || shipOnFire ? 'block' : 'none';
    this.ui.stormWarning.textContent = shipCritical
      ? (ship?.sinking ? 'SHIP IS SINKING' : 'SHIP CRITICAL - REPAIR NOW')
      : shipOnFire
        ? 'FIRE ABOARD - REPAIR TO DOUSE IT'
        : 'OUTSIDE STORM ZONE';
    this.ui.stormWarning.style.color = shipCritical || shipOnFire ? '#ffb366' : '#ff6b6b';

    this.ui.shipsAlive.textContent = String(this.state.shipsAlive);
    this.ui.goldAmount.textContent = `${player.gold}/${ECONOMY.GOLD_WIN_TARGET}`;
    this.ui.healthFill.style.width = `${Math.max(0, player.health)}%`;
    this.ui.armorFill.style.width = '0%';

    if (ship) {
      this.setHull(this.ui.hullBow, this.ui.hullBowTxt, ship.hull.bow);
      this.setHull(this.ui.hullStern, this.ui.hullSternTxt, ship.hull.stern);
      this.setHull(this.ui.hullPort, this.ui.hullPortTxt, ship.hull.port);
      this.setHull(this.ui.hullStarboard, this.ui.hullStarboardTxt, ship.hull.starboard);
      const wind = sampleWind(this.ocean.getTime());
      const signedRelative = angleWrap(wind.direction - ship.rotation);
      const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.95;
      const trimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
      const trimDelta = angleWrap(desiredTrim - ship.sailAngle);
      const trimSide = ship.sailAngle < -0.06 ? 'Port' : ship.sailAngle > 0.06 ? 'Starboard' : 'Centered';
      const windSide = signedRelative < -0.22 ? 'from port' : signedRelative > 0.22 ? 'from starboard' : Math.cos(signedRelative) >= 0 ? 'dead ahead' : 'from astern';
      const windHeading = this.formatCompassHeading(wind.direction);
      const windArrow = signedRelative < -0.22 ? '<-' : signedRelative > 0.22 ? '->' : Math.cos(signedRelative) >= 0 ? '^' : 'v';
      const windDegrees = Math.round(Math.abs(THREE.MathUtils.radToDeg(signedRelative)));
      const trimHint = Math.abs(trimDelta) < 0.08
        ? 'Trim set'
        : trimDelta > 0
          ? 'Trim Right [F]'
          : 'Trim Left [Q]';
      const rig =
        ship.sailIntegrity < 0.99
          ? ` · Rigging ${Math.round(ship.sailIntegrity * 100)}% (hold [X] at sails + planks)`
          : '';
      this.ui.sailStatus.textContent = ship.anchored
        ? `Anchor Dropped · Hold [X] at capstan to raise · Wind ${windHeading} ${windArrow} ${windDegrees}deg ${windSide}`
        : `Sail power ${Math.round(ship.sailHeight * 100)}%${rig} · Trim ${trimSide} · Wind ${windHeading} ${windArrow} ${windDegrees}deg ${windSide} · Catch ${Math.round(trimCatch * 100)}% · ${trimHint}`;
    } else {
      this.ui.sailStatus.textContent = 'No tracked ship';
    }
    this.renderShipUpgrades(ship);
    this.renderShipInventory(ship, player);
    this.renderKegStatus(player);

    const pk = player;
    const mappedIsland = pk.treasureMapIslandId
      ? this.state.islands.find((island) => island.id === pk.treasureMapIslandId) ?? null
      : null;
    const closestHoarder = this.getClosestGoldHoarder(pk);
    const stripParts = [
      `Pocket: 1 Banana ${pk.pocketBanana}`,
      `2 Plank ${pk.pocketWood}`,
      `3 Coconut ${pk.pocketCoconut}`,
      `4 Mango ${pk.pocketMango}`,
      `Tool: ${pk.hasShovel ? 'Shovel' : 'None'}`,
    ];
    if (mappedIsland) stripParts.push(`Chart: ${mappedIsland.name}`);
    if (closestHoarder && (mappedIsland || pk.carryingChestId)) stripParts.push(`Gold Hoarder: ${closestHoarder.island.name}`);
    const pocketText = stripParts.join(' | ');
    if (pocketText !== this.pocketStripSignature) {
      this.ui.pocketStrip.textContent = pocketText;
      this.pocketStripSignature = pocketText;
    }
    this.renderTreasureInventoryChart(player, mappedIsland, closestHoarder);
    this.ui.pocketWheelStats.textContent = this.input.isSupplyWheelOpen()
      ? 'Fruit heals immediately · Planks go to ship repairs'
      : '';
    this.updateSupplyWheelCounts(player);
    this.ui.pocketWheel.classList.toggle('visible', this.input.isSupplyWheelOpen());

    let insideIslandId: string | null = null;
    for (const isl of this.state.islands) {
      if (isPointInsideIslandFootprint(isl, player.position.x, player.position.z, 6)) {
        insideIslandId = isl.id;
        break;
      }
    }
    if (insideIslandId && insideIslandId !== this.prevIsInsideIsland) {
      const isl = this.state.islands.find((i) => i.id === insideIslandId);
      if (isl) {
        this.flashIslandBanner(isl.name);
        this.playIslandArrivalFanfare();
      }
    }
    this.prevIsInsideIsland = insideIslandId;
    if (performance.now() > this.islandBannerHideAt) {
      this.ui.islandBanner.classList.remove('visible');
    }

    const weapon = player.atHelm || player.atSails || player.atCrowNest ? null : player.weapons[player.activeSlot];
    if (player.atCannon && ship) {
      this.ui.ammoCurrent.textContent = player.selectedCannonAmmo === 'cannonball'
        ? '∞'
        : String(
          player.selectedCannonAmmo === 'firebomb'
            ? this.getInventoryQty(ship, 'firebomb_ball')
            : this.getInventoryQty(ship, 'chainshot'),
        );
      this.ui.ammoReserve.textContent = player.selectedCannonAmmo === 'cannonball'
        ? 'cannonballs'
        : player.selectedCannonAmmo.replace('_', ' ');
      this.ui.reloadIndicator.style.display = ship.cannonCooldowns[player.cannonIndex] > 0 ? 'block' : 'none';
    } else {
      this.updateWeaponHud(player.activeSlot, weapon, player.weapons);
      this.ui.reloadIndicator.style.display = weapon?.reloading ? 'block' : 'none';
    }
    this.ui.scopeOverlay.style.display =
      this.input.isAiming() && weapon && WEAPONS[weapon.weaponId].scopeFov ? 'block' : 'none';
    this.ui.crosshair.classList.toggle('cannon', player.atCannon);
    const shotgunCrosshair = !player.atCannon && weapon?.weaponId === 'blunderbuss';
    this.ui.crosshair.classList.toggle('shotgun', shotgunCrosshair);
    if (shotgunCrosshair) {
      this.ui.crosshair.style.setProperty('--shotgun-spread', `${this.getBlunderbussCrosshairSize(player)}px`);
    } else {
      this.ui.crosshair.style.removeProperty('--shotgun-spread');
    }

    const nearbyCannon = ship ? this.findNearbyCannonIndex(player, ship) : null;
    const repairSection = ship ? this.findRepairableHullSection(player, ship) : null;
    const lookInteraction = this.getLookInteraction(player, ship, nearbyCannon, repairSection);
    this.visibleInteractKind = null;

    if (player.state === 'respawning') {
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = `Respawning in ${Math.max(1, Math.ceil(player.respawnTimer))}`;
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = 'Returning to your ship';
    } else if (player.atCannon) {
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = '[X] Leave Cannon · [SPACE] Launch Yourself';
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = `Cannon ${player.cannonIndex + 1} · ${player.selectedCannonAmmo.replace('_', ' ')} · [4/5/6] shot type`;
    } else if (player.atHelm) {
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = '[X] Leave Helm';
      this.ui.contextLabel.style.display = 'block';
      if (ship) {
        this.ui.contextLabel.textContent = `${ship.anchored ? 'Anchored' : 'At the wheel'} · A/D steer · compass on starboard side`;
      } else {
        this.ui.contextLabel.textContent = 'At the wheel';
      }
    } else if (player.atSails) {
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = '[X] Leave Sail Ring';
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = 'Sail ring · C/Z hoist · Q/F angle · hold [X] + planks to mend canvas';
    } else if (player.atCrowNest) {
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = '[X] Climb Down From Crow\'s Nest';
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = 'Spotting from the main mast';
    } else if (lookInteraction) {
      this.visibleInteractKind = lookInteraction.kind;
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = lookInteraction.prompt;
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = lookInteraction.label;
    } else {
      this.ui.interactPrompt.style.display = 'none';
      const ambientLabel = player.state === 'swimming'
        ? 'Swimming · W follows look · Space up · Z down · LMB fire · Shift/RMB aim'
        : `First-person BR · [V] hold supply wheel (1–4) · Pocket counts below · Shift/RMB ADS · ${this.getKegSummary(player)}`;
      this.ui.contextLabel.style.display = ambientLabel ? 'block' : 'none';
      this.ui.contextLabel.textContent = ambientLabel;
    }

    const heading = ((player.rotation.x * 180) / Math.PI + 360) % 360;
    this.ui.compassTape.style.transform = `translateX(${Math.round(-heading * 2.6)}px)`;
    this.ui.compassTape.style.opacity = '1';

    if (this.state.phase === 'ended') {
      if (this.state.winnerId === this.localPlayerId) {
        this.showVictory(player.kills, player.gold);
      } else {
        this.returnToLobbyAfterLoss(player.kills, player.gold, 'Crew lost');
      }
    } else if (player.state === 'eliminated') {
      this.returnToLobbyAfterLoss(player.kills, player.gold, 'Crew lost');
    } else if (player.state === 'respawning') {
      this.ui.deathScreen.style.display = 'none';
    }
  }

  private drawMaps() {
    if (!this.state) return;

    const minimapCtx = this.ui.minimapCanvas.getContext('2d');
    if (minimapCtx) {
      this.renderBattleMap(minimapCtx, this.ui.minimapCanvas.width, this.ui.minimapCanvas.height, false);
    }

    if (this.mapOpen) {
      const mapCtx = this.ui.mapCanvas.getContext('2d');
      if (mapCtx) {
        this.renderBattleMap(mapCtx, this.ui.mapCanvas.width, this.ui.mapCanvas.height, true);
      }
    }
  }

  private renderTreasureInventoryChart(
    player: Player,
    mappedIsland: Island | null,
    closestHoarder: { npc: IslandNpc; island: Island; distance: number } | null,
  ) {
    const chartIsland = mappedIsland ?? (player.carryingChestId ? closestHoarder?.island ?? null : null);
    if (!chartIsland) {
      this.ui.treasureChart.classList.remove('visible');
      this.treasureChartSignature = '';
      return;
    }

    this.ui.treasureChart.classList.add('visible');
    const treasureMarks = mappedIsland ? this.getTreasureChartChests(chartIsland) : [];
    const routeText = player.carryingChestId
      ? `Return chest to Gold Hoarder at ${closestHoarder?.island.name ?? chartIsland.name}`
      : treasureMarks.length > 0
        ? `${treasureMarks.length} buried X mark${treasureMarks.length === 1 ? '' : 's'} | shovel in pocket`
        : `No buried marks left | return to ${closestHoarder?.island.name ?? 'Gold Hoarder'}`;
    const islandText = mappedIsland ? `Gold Hoarder chart: ${chartIsland.name}` : 'Gold Hoarder return';
    if (this.ui.treasureChartIsland.textContent !== islandText) this.ui.treasureChartIsland.textContent = islandText;
    if (this.ui.treasureChartRoute.textContent !== routeText) this.ui.treasureChartRoute.textContent = routeText;

    const markSig = treasureMarks
      .map((chest) => `${chest.id}:${Math.round(chest.digProgress * 100)}:${chest.carriedByPlayerId ?? ''}:${chest.storedOnShipId ?? ''}`)
      .join(',');
    const hoarderSig = closestHoarder ? closestHoarder.island.id : 'none';
    const signature = `${chartIsland.id}:${mappedIsland ? 1 : 0}:${player.carryingChestId ?? ''}:${markSig}:${hoarderSig}:${this.ui.treasureChartCanvas.width}x${this.ui.treasureChartCanvas.height}`;
    if (signature === this.treasureChartSignature) return;
    this.treasureChartSignature = signature;

    const canvas = this.ui.treasureChartCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const parchment = ctx.createLinearGradient(0, 0, width, height);
    parchment.addColorStop(0, '#e3ca8a');
    parchment.addColorStop(0.55, '#d2ae63');
    parchment.addColorStop(1, '#b9853f');
    ctx.fillStyle = parchment;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = 'rgba(75, 45, 18, 0.14)';
    ctx.lineWidth = 1;
    for (let x = 14; x < width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 16, height);
      ctx.stroke();
    }
    for (let y = 12; y < height; y += 22) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y + 10);
      ctx.stroke();
    }
    ctx.restore();

    const cx = width * 0.5;
    const cy = height * 0.53;
    const mapScale = Math.min(width, height) * 0.38 / Math.max(1, chartIsland.radius);
    const toMap = (x: number, z: number) => ({
      x: cx + (x - chartIsland.position.x) * mapScale,
      y: cy + (z - chartIsland.position.z) * mapScale,
    });

    ctx.save();
    ctx.fillStyle = '#8a6b36';
    ctx.strokeStyle = 'rgba(60, 35, 12, 0.76)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const segments = 42;
    for (let segment = 0; segment <= segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const point = getIslandSurfacePoint(chartIsland, 0.98, angle, 0);
      const mapped = toMap(point.x, point.z);
      if (segment === 0) ctx.moveTo(mapped.x, mapped.y);
      else ctx.lineTo(mapped.x, mapped.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(67, 88, 35, 0.58)';
    ctx.beginPath();
    for (let segment = 0; segment <= segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const point = getIslandSurfacePoint(chartIsland, 0.54, angle, 0);
      const mapped = toMap(point.x, point.z);
      if (segment === 0) ctx.moveTo(mapped.x, mapped.y);
      else ctx.lineTo(mapped.x, mapped.y);
    }
    ctx.closePath();
    ctx.fill();

    if (chartIsland.dock) {
      const dock = chartIsland.dock;
      const mapped = toMap(dock.position.x, dock.position.z);
      ctx.save();
      ctx.translate(mapped.x, mapped.y);
      ctx.rotate(Math.PI - dock.rotation);
      ctx.fillStyle = '#5f3719';
      ctx.fillRect(-dock.width * mapScale * 0.5, -dock.length * mapScale * 0.5, dock.width * mapScale, dock.length * mapScale);
      ctx.restore();
    }

    for (const chest of treasureMarks) {
      const mapped = toMap(chest.position.x, chest.position.z);
      this.drawTreasureX(ctx, mapped.x, mapped.y, 10, '#741616');
    }

    const hoarder = (chartIsland.npcs ?? []).find((npc) => npc.role === 'gold_hoarder') ?? null;
    if (hoarder) {
      const mapped = toMap(hoarder.position.x, hoarder.position.z);
      ctx.fillStyle = '#f0c65a';
      ctx.strokeStyle = '#3c240d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mapped.x, mapped.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2b1a08';
      ctx.font = '700 7px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GH', mapped.x, mapped.y + 0.2);
    }

    ctx.restore();
  }

  private getTreasureChartChests(island: Island): TreasureChest[] {
    return island.chests.filter((chest) =>
      chest.buried
      && chest.digProgress < 1
      && !chest.opened
      && !chest.carriedByPlayerId
      && !chest.storedOnShipId
      && !chest.floating
    );
  }

  private drawTreasureX(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, size * 0.22);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - size * 0.48, y - size * 0.48);
    ctx.lineTo(x + size * 0.48, y + size * 0.48);
    ctx.moveTo(x + size * 0.48, y - size * 0.48);
    ctx.lineTo(x - size * 0.48, y + size * 0.48);
    ctx.stroke();
    ctx.restore();
  }

  private renderBattleMap(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    fullscreen: boolean,
  ) {
    if (!this.state) return;

    const centerX = width * 0.5;
    const centerY = height * 0.5;
    const scale = Math.min(width, height) / WORLD.SIZE;
    const trackedShip = this.getTrackedShip();
    const localPlayer = this.getLocalPlayer();
    const localX = trackedShip?.position.x ?? localPlayer?.position.x ?? 0;
    const localZ = trackedShip?.position.z ?? localPlayer?.position.z ?? 0;
    const localHeading = trackedShip
      ? trackedShip.rotation
      : (localPlayer?.rotation.x ?? this.input.getYaw());
    const stormX = centerX + this.state.storm.centerX * scale;
    const stormY = centerY + this.state.storm.centerZ * scale;
    const stormRadius = this.state.storm.safeRadius * scale;
    const nextRadius = Math.max(0, this.state.storm.nextRadius * scale);

    ctx.clearRect(0, 0, width, height);

    const oceanGradient = ctx.createLinearGradient(0, 0, 0, height);
    oceanGradient.addColorStop(0, fullscreen ? '#0d213d' : '#102947');
    oceanGradient.addColorStop(1, fullscreen ? '#06111f' : '#081321');
    ctx.fillStyle = oceanGradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = fullscreen ? 'rgba(150, 192, 237, 0.08)' : 'rgba(150, 192, 237, 0.06)';
    ctx.lineWidth = 1;
    const gridStep = WORLD.SIZE / 8;
    for (let world = -WORLD.HALF; world <= WORLD.HALF; world += gridStep) {
      const x = centerX + world * scale;
      const y = centerY + world * scale;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = fullscreen ? 'rgba(110, 70, 170, 0.4)' : 'rgba(110, 70, 170, 0.34)';
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.arc(stormX, stormY, stormRadius, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();

    if (nextRadius > 0 && nextRadius < stormRadius - 1) {
      ctx.save();
      ctx.setLineDash(fullscreen ? [16, 12] : [8, 6]);
      ctx.strokeStyle = 'rgba(233, 244, 255, 0.78)';
      ctx.lineWidth = fullscreen ? 3 : 2;
      ctx.beginPath();
      ctx.arc(stormX, stormY, nextRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = this.state.storm.shrinking ? 'rgba(188, 214, 255, 0.95)' : 'rgba(143, 114, 255, 0.95)';
    ctx.lineWidth = fullscreen ? 4 : 2.5;
    ctx.beginPath();
    ctx.arc(stormX, stormY, stormRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    for (const island of this.state.islands) {
      this.drawIslandChart(ctx, island, centerX, centerY, scale, fullscreen);
    }
    ctx.restore();

    const closestHoarder = fullscreen && localPlayer ? this.getClosestGoldHoarder(localPlayer) : null;
    if (fullscreen && localPlayer && closestHoarder && (localPlayer.treasureMapIslandId || localPlayer.carryingChestId)) {
      const hx = centerX + closestHoarder.npc.position.x * scale;
      const hy = centerY + closestHoarder.npc.position.z * scale;
      const px = centerX + localX * scale;
      const py = centerY + localZ * scale;
      ctx.save();
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = 'rgba(240, 198, 90, 0.72)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f0c65a';
      ctx.strokeStyle = 'rgba(42, 24, 7, 0.92)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#2b1a08';
      ctx.font = '700 8px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GH', hx, hy + 0.2);
      ctx.fillStyle = '#f5dfa7';
      ctx.font = '600 12px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`Gold Hoarder - ${closestHoarder.island.name}`, hx + 11, hy - 8);
      ctx.restore();
    }

    if (fullscreen) {
      const mappedIsland = localPlayer?.treasureMapIslandId
        ? this.state.islands.find((island) => island.id === localPlayer.treasureMapIslandId) ?? null
        : null;
      const chart = mappedIsland ?? this.getNearestIsland(localX, localZ);
      const hasGoldMap = !!mappedIsland;
      if (chart) {
        const inset = 128;
        const ix = width - inset - 26;
        const iy = height - inset - 26;
        ctx.fillStyle = 'rgba(18, 12, 6, 0.9)';
        ctx.fillRect(ix, iy, inset, inset);
        ctx.strokeStyle = 'rgba(201, 168, 76, 0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(ix, iy, inset, inset);
        ctx.fillStyle = '#e8d5a3';
        ctx.font = '600 11px Georgia, serif';
        ctx.fillText(chart.name, ix + 8, iy + 16);
        ctx.fillStyle = 'rgba(200, 190, 168, 0.72)';
        ctx.font = '9px Georgia, serif';
        ctx.fillText(hasGoldMap ? 'Gold Hoarder chart' : 'No treasure chart yet', ix + 8, iy + 30);
        const cx = ix + inset * 0.5;
        const cy = iy + inset * 0.54;
        ctx.fillStyle = 'rgba(110, 86, 56, 0.55)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, inset * 0.36, inset * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(201, 168, 76, 0.4)';
        ctx.stroke();
        for (const c of hasGoldMap ? this.getTreasureChartChests(chart) : []) {
          if (c.opened || c.carriedByPlayerId || c.storedOnShipId || c.floating) continue;
          const mx = cx + c.mapOffsetX * inset * 0.3;
          const my = cy + c.mapOffsetZ * inset * 0.3;
          this.drawTreasureX(ctx, mx, my, 8, '#7a1515');
        }
      }
    }

    for (const ship of this.state.ships) {
      if (!ship.alive || ship.sinking) continue;
      if (ship.id === trackedShip?.id) continue;
      this.drawShipMarker(
        ctx,
        centerX + ship.position.x * scale,
        centerY + ship.position.z * scale,
        ship.rotation,
        fullscreen ? 12 : 7.5,
        '#ff8f70',
        'rgba(43, 12, 8, 0.55)',
      );
    }

    this.drawShipMarker(
      ctx,
      centerX + localX * scale,
      centerY + localZ * scale,
      localHeading,
      fullscreen ? 15 : 9,
      '#ffffff',
      'rgba(55, 164, 235, 0.92)',
    );

    ctx.save();
    ctx.translate(centerX + localX * scale, centerY + localZ * scale);
    ctx.rotate(Math.PI - localHeading);
    ctx.fillStyle = fullscreen ? 'rgba(103, 197, 255, 0.18)' : 'rgba(103, 197, 255, 0.14)';
    const coneTip = fullscreen ? 28 : 18;
    const coneBaseX = fullscreen ? 14 : 9;
    const coneBaseY = fullscreen ? 8 : 5;
    ctx.beginPath();
    ctx.moveTo(0, -coneTip);
    ctx.lineTo(coneBaseX, coneBaseY);
    ctx.lineTo(-coneBaseX, coneBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawShipMarker(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rotation: number,
    size: number,
    fill: string,
    stroke: string,
  ) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - rotation);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.72, size * 0.65);
    ctx.lineTo(0, size * 0.34);
    ctx.lineTo(-size * 0.72, size * 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawIslandChart(
    ctx: CanvasRenderingContext2D,
    island: Island,
    centerX: number,
    centerY: number,
    scale: number,
    fullscreen: boolean,
  ) {
    const detailSegments = fullscreen ? 28 : 18;
    ctx.save();
    ctx.fillStyle = fullscreen ? '#d9bf80' : '#d6bc83';
    ctx.strokeStyle = fullscreen ? 'rgba(69, 45, 18, 0.72)' : 'rgba(65, 41, 14, 0.58)';
    ctx.lineWidth = fullscreen ? 2 : 1;
    ctx.beginPath();
    for (let segment = 0; segment <= detailSegments; segment++) {
      const angle = (segment / detailSegments) * Math.PI * 2;
      const point = getIslandSurfacePoint(island, 0.98, angle, 0);
      const x = centerX + point.x * scale;
      const y = centerY + point.z * scale;
      if (segment === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (fullscreen) {
      ctx.strokeStyle = 'rgba(76, 112, 61, 0.38)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let segment = 0; segment <= detailSegments; segment++) {
        const angle = (segment / detailSegments) * Math.PI * 2;
        const point = getIslandSurfacePoint(island, 0.55, angle, 0);
        const x = centerX + point.x * scale;
        const y = centerY + point.z * scale;
        if (segment === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    if (island.dock) {
      const dock = island.dock;
      const dx = centerX + dock.position.x * scale;
      const dy = centerY + dock.position.z * scale;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(Math.PI - dock.rotation);
      ctx.fillStyle = fullscreen ? 'rgba(124, 82, 42, 0.95)' : 'rgba(124, 82, 42, 0.82)';
      ctx.fillRect(
        -Math.max(1.5, dock.width * scale * 0.5),
        -Math.max(4, dock.length * scale * 0.5),
        Math.max(3, dock.width * scale),
        Math.max(8, dock.length * scale),
      );
      ctx.restore();
    }

    for (const station of island.upgradeStations) {
      const claimed = station.claimedByShipId !== null;
      const sx = centerX + station.position.x * scale;
      const sy = centerY + station.position.z * scale;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI * 0.25);
      ctx.fillStyle = claimed ? 'rgba(120, 126, 138, 0.7)' : 'rgba(246, 194, 86, 0.95)';
      const size = fullscreen ? 4.5 : 2.6;
      ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
      ctx.restore();
    }

    if (fullscreen) {
      for (const npc of island.npcs ?? []) {
        const nx = centerX + npc.position.x * scale;
        const ny = centerY + npc.position.z * scale;
        if (npc.role === 'gold_hoarder') {
          ctx.fillStyle = '#f0c65a';
          ctx.strokeStyle = 'rgba(41, 29, 12, 0.92)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(nx, ny, 4.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#2b1a08';
          ctx.font = '700 6px Georgia, serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('GH', nx, ny + 0.2);
        } else {
          ctx.fillStyle = 'rgba(235, 221, 169, 0.95)';
          ctx.strokeStyle = 'rgba(41, 29, 12, 0.78)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(nx, ny, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  private updateWeaponHud(activeSlot: number, activeWeapon: WeaponInstance | null, loadout: Array<WeaponInstance | null>) {
    for (const [slotIndex, slotEl] of this.ui.weaponSlots.entries()) {
      slotEl.classList.toggle('active', slotIndex === activeSlot);
      const weapon = loadout[slotIndex];
      const nameEl = slotEl.querySelector('.wname');
      const ammoEl = slotEl.querySelector('.ammo');
      if (nameEl) {
        nameEl.textContent = weapon ? WEAPONS[weapon.weaponId].name.replace(' Pistol', '') : 'Empty';
      }
      if (ammoEl) {
        ammoEl.textContent = weapon && WEAPONS[weapon.weaponId].ammoMax > 0
          ? `${weapon.ammo}/∞`
          : '∞';
      }
    }

    if (!activeWeapon || WEAPONS[activeWeapon.weaponId].ammoMax === 0) {
      this.ui.ammoCurrent.textContent = '∞';
      this.ui.ammoReserve.textContent = '∞';
      return;
    }

    this.ui.ammoCurrent.textContent = String(activeWeapon.ammo);
    this.ui.ammoReserve.textContent = '∞';
  }

  private updateDamageFx() {
    if (!this.localPlayerId) return;

    const player = this.playersById.get(this.localPlayerId);
    if (!player) return;

    if (player.health < this.previousHealth) {
      this.ui.damageVignette.style.opacity = '1';
      window.setTimeout(() => {
        this.ui.damageVignette.style.opacity = '0';
      }, 160);
    }

    const knockbackMagnitude = Math.hypot(
      player.knockbackVelocity.x,
      player.knockbackVelocity.y,
      player.knockbackVelocity.z,
    );
    if (knockbackMagnitude > this.previousKnockback + 2) {
      this.ui.knockbackFlash.style.opacity = '0.8';
      window.setTimeout(() => {
        this.ui.knockbackFlash.style.opacity = '0';
      }, 90);
    }

    this.previousKnockback = knockbackMagnitude;
    this.previousHealth = player.health;
  }

  private updateCombatHud(dt: number) {
    if (this.hitMarkerTimer > 0) {
      this.hitMarkerTimer = Math.max(0, this.hitMarkerTimer - dt);
    }
    const hitMarkerActive = this.hitMarkerTimer > 0;
    this.ui.hitMarker.classList.toggle('visible', hitMarkerActive);
    this.ui.hitMarker.classList.toggle('ship', hitMarkerActive && this.hitMarkerShip);
    this.ui.hitMarker.classList.toggle('shark', hitMarkerActive && this.hitMarkerShark);
    this.ui.hitMarker.classList.toggle('headshot', hitMarkerActive && this.hitMarkerHeadshot);
    this.ui.hitMarker.classList.toggle('kill', hitMarkerActive && this.hitMarkerKill);
    if (!hitMarkerActive) {
      this.hitMarkerShip = false;
      this.hitMarkerShark = false;
      this.hitMarkerHeadshot = false;
      this.hitMarkerKill = false;
    }

    if (this.floatingDamageIndicators.length === 0) return;

    this.renderer.camera.updateMatrixWorld();
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (let index = this.floatingDamageIndicators.length - 1; index >= 0; index--) {
      const indicator = this.floatingDamageIndicators[index];
      indicator.life += dt;
      indicator.worldPos.y += indicator.riseSpeed * dt;
      const progress = Math.min(1, indicator.life / indicator.duration);
      this.tempHudVector.copy(indicator.worldPos).project(this.renderer.camera);

      const visible = this.tempHudVector.z > -1 && this.tempHudVector.z < 1;
      if (!visible) {
        indicator.element.style.opacity = '0';
      } else {
        const x = (this.tempHudVector.x * 0.5 + 0.5) * width;
        const y = (-this.tempHudVector.y * 0.5 + 0.5) * height;
        indicator.element.style.left = `${x}px`;
        indicator.element.style.top = `${y}px`;
        indicator.element.style.opacity = `${1 - progress}`;
        indicator.element.style.transform = `translate(-50%, -50%) translateY(${-progress * 44}px) scale(${1 + (1 - progress) * 0.18})`;
      }

      if (progress >= 1) {
        indicator.element.remove();
        this.floatingDamageIndicators.splice(index, 1);
      }
    }
  }

  private syncTradeUi(snapshot: GameState) {
    const session = this.getActiveTradeSession(snapshot);
    const player = snapshot.players.find((candidate) => candidate.id === this.localPlayerId) ?? null;
    const ship = this.getTrackedShipFromState(snapshot);

    if (!session || !player || !ship) {
      this.activeTradeSessionId = null;
      this.localTradeOffer = [];
      this.ui.tradeUi.style.display = 'none';
      return;
    }

    const localIsInitiator = session.initiatorId === this.localPlayerId;
    const localOffer = localIsInitiator ? session.initiatorOffer : session.targetOffer;
    const remoteOffer = localIsInitiator ? session.targetOffer : session.initiatorOffer;
    const localConfirmed = localIsInitiator ? session.initiatorConfirmed : session.targetConfirmed;

    if (this.activeTradeSessionId !== session.id) {
      this.activeTradeSessionId = session.id;
      this.localTradeOffer = this.cloneOffer(localOffer);
    }
    if (JSON.stringify(this.localTradeOffer) !== JSON.stringify(localOffer)) {
      this.localTradeOffer = this.cloneOffer(localOffer);
    }

    this.ui.tradeUi.style.display = 'flex';
    this.ui.tradeTimer.textContent = session.betrayalWindow
      ? `Betrayal window: ${session.timer.toFixed(1)}s`
      : `Parley expires in ${Math.ceil(session.timer)}s`;

    this.renderTradeOfferButtons(player, ship, session.id, localConfirmed);
    this.renderTradeOfferSummary(this.ui.theirTradeItems, remoteOffer, 'No offer yet');
    this.ui.tradeConfirm.disabled = localConfirmed;
    this.ui.tradeConfirm.textContent = localConfirmed ? 'OFFER LOCKED' : 'CONFIRM TRADE';
  }

  private renderTradeOfferButtons(player: Player, ship: Ship, sessionId: string, disabled: boolean) {
    const options = [
      { item: 'gold', qty: Math.min(100, player.gold), label: '100 Gold' },
      { item: 'cannonball', qty: Math.min(5, this.getInventoryQty(ship, 'cannonball')), label: '5 Cannonballs' },
      { item: 'wood_plank', qty: Math.min(2, this.getInventoryQty(ship, 'wood_plank')), label: '2 Planks' },
      { item: 'firebomb_ball', qty: Math.min(1, this.getInventoryQty(ship, 'firebomb_ball')), label: '1 Firebomb' },
      { item: 'chainshot', qty: Math.min(1, this.getInventoryQty(ship, 'chainshot')), label: '1 Chainshot' },
      { item: 'banana', qty: Math.min(1, this.getInventoryQty(ship, 'banana')), label: '1 Banana' },
    ].filter((option) => option.qty > 0);

    this.ui.yourTradeItems.innerHTML = '';
    if (options.length === 0) {
      this.renderTradeOfferSummary(this.ui.yourTradeItems, this.localTradeOffer, 'Nothing to offer');
      return;
    }

    for (const option of options) {
      const button = document.createElement('button');
      button.className = 'trade-btn';
      button.textContent = this.localTradeOffer.some((entry) => entry.item === option.item) ? `Remove ${option.label}` : option.label;
      button.disabled = disabled;
      button.style.display = 'block';
      button.style.width = '100%';
      button.style.marginBottom = '8px';
      button.style.opacity = disabled ? '0.55' : '1';
      button.addEventListener('click', () => {
        const existing = this.localTradeOffer.find((entry) => entry.item === option.item);
        this.localTradeOffer = existing
          ? this.localTradeOffer.filter((entry) => entry.item !== option.item)
          : [...this.localTradeOffer, { item: option.item as ItemStack['item'], qty: option.qty }];
        this.network.sendTradeAction({
          action: 'offer',
          sessionId,
          offer: this.localTradeOffer,
        });
        if (this.state) this.syncTradeUi(this.state);
      });
      this.ui.yourTradeItems.appendChild(button);
    }

    const summary = document.createElement('div');
    summary.style.marginTop = '8px';
    summary.style.fontSize = '0.72rem';
    summary.style.color = '#d8d1c0';
    summary.textContent = this.localTradeOffer.length > 0
      ? `Selected: ${this.localTradeOffer.map((entry) => this.formatTradeItem(entry)).join(', ')}`
      : 'Selected: nothing yet';
    this.ui.yourTradeItems.appendChild(summary);
  }

  private renderTradeOfferSummary(container: HTMLDivElement, offer: ItemStack[], emptyLabel: string) {
    container.innerHTML = '';
    if (offer.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = emptyLabel;
      empty.style.color = '#9aa6af';
      empty.style.fontSize = '0.75rem';
      container.appendChild(empty);
      return;
    }

    for (const entry of offer) {
      const row = document.createElement('div');
      row.textContent = this.formatTradeItem(entry);
      row.style.marginBottom = '8px';
      row.style.fontSize = '0.78rem';
      row.style.color = '#f0e5c6';
      container.appendChild(row);
    }
  }

  private setHull(fill: HTMLDivElement, label: HTMLElement, value: number) {
    const percent = Math.round(value * 100);
    fill.style.width = `${percent}%`;
    label.textContent = `${percent}%`;
  }

  private renderShipInventory(ship: Ship | null, player: Player) {
    const visible = !!ship && player.onShipId === ship.id && player.state !== 'swimming';
    this.ui.shipInventory.classList.toggle('visible', visible);
    if (!ship) {
      this.shipInventorySignature = '';
      return;
    }

    const wood = this.getInventoryQty(ship, 'wood_plank');
    const cannonball = this.getInventoryQty(ship, 'cannonball');
    const firebomb = this.getInventoryQty(ship, 'firebomb_ball');
    const chainshot = this.getInventoryQty(ship, 'chainshot');
    const banana = this.getInventoryQty(ship, 'banana');
    const signature = `${ship.id}:${wood}:${cannonball}:${firebomb}:${chainshot}:${banana}`;
    if (signature === this.shipInventorySignature) return;
    this.shipInventorySignature = signature;
    this.ui.inventoryWood.textContent = String(wood);
    this.ui.inventoryCannonball.textContent = String(cannonball);
    this.ui.inventoryFirebomb.textContent = String(firebomb);
    this.ui.inventoryChainshot.textContent = String(chainshot);
    this.ui.inventoryBanana.textContent = String(banana);
  }

  private updateSupplyWheelCounts(player: Player) {
    const counts = [player.pocketBanana, player.pocketWood, player.pocketCoconut, player.pocketMango];
    for (const countEl of this.ui.pocketWheel.querySelectorAll<SVGTextElement>('[data-wheel-count]')) {
      const slot = Number(countEl.dataset.wheelCount);
      countEl.textContent = Number.isInteger(slot) ? String(counts[slot] ?? 0) : '0';
    }
    const heldSlot = this.input.getSupplyWheelHeldSlot();
    for (const slice of this.ui.pocketWheel.querySelectorAll<SVGPathElement>('[data-wheel-slot]')) {
      slice.classList.toggle('active', Number(slice.dataset.wheelSlot) === heldSlot);
    }
  }

  private startPocketUsePreview(slot: number) {
    const kinds: PocketPreviewKind[] = ['banana', 'wood', 'coconut', 'mango'];
    const kind = kinds[slot];
    if (!kind) return;
    const player = this.getLocalPlayer();
    const counts = player ? [player.pocketBanana, player.pocketWood, player.pocketCoconut, player.pocketMango] : [];
    if ((counts[slot] ?? 0) <= 0) return;
    this.pocketUsePreviewKind = kind;
    this.pocketUsePreviewTimer = kind === 'wood' ? 0.45 : 0.82;
  }

  private renderShipUpgrades(ship: Ship | null) {
    if (!ship || ship.upgrades.length === 0) {
      if (this.shipUpgradeSignature !== '') {
        this.ui.shipUpgrades.innerHTML = '';
        this.shipUpgradeSignature = '';
      }
      return;
    }

    const signature = `${ship.id}:${ship.upgrades.map((upgrade) => upgrade.type).join('|')}`;
    if (signature === this.shipUpgradeSignature) return;
    this.shipUpgradeSignature = signature;
    this.ui.shipUpgrades.innerHTML = ship.upgrades
      .map((upgrade) => {
        const meta = this.getUpgradePresentation(upgrade.type);
        return `<span class="upgrade-pill" data-type="${upgrade.type}">${meta.icon} ${meta.short}</span>`;
      })
      .join('');
  }

  private renderKegStatus(player: Player) {
    const hidden = player.state === 'eliminated' || player.state === 'respawning';
    this.ui.kegStatus.classList.toggle('visible', !hidden);
    this.ui.kegStatusValue.textContent = this.getKegSummary(player);
  }

  private getKegSummary(player: Player) {
    if (player.kegs <= 0) return 'None remaining';
    if (player.kegCooldown > 0) return `${Math.max(1, Math.ceil(player.kegCooldown))}s until second keg`;
    return player.kegs === 1 ? '1 ready' : `${player.kegs} ready`;
  }

  private getUpgradePresentation(type: ShipUpgradeType) {
    switch (type) {
      case 'hull_reinforcement':
        return {
          name: 'Hull Reinforcement',
          short: 'Hull+',
          icon: '🛡',
          color: '#8fd0ff',
          hex: 0x67b9ff,
          effect: '+25% hull durability',
        };
      case 'charged_cannons':
        return {
          name: 'Charged Cannons',
          short: 'Cannons+',
          icon: '✹',
          color: '#ffb08a',
          hex: 0xff8459,
          effect: '+30% cannon damage',
        };
      case 'swift_sails':
      default:
        return {
          name: 'Swift Sails',
          short: 'Sails+',
          icon: '✦',
          color: '#f7de84',
          hex: 0xf6d360,
          effect: '+20% sail speed',
        };
    }
  }

  private pushFeed(message: string, color = '#e7e1d4') {
    const item = document.createElement('div');
    item.textContent = message;
    item.style.color = color;
    item.style.marginBottom = '8px';
    item.style.textShadow = '0 2px 6px rgba(0, 0, 0, 0.55)';
    this.ui.killFeed.prepend(item);
    while (this.ui.killFeed.childElementCount > 5) {
      this.ui.killFeed.lastElementChild?.remove();
    }
    window.setTimeout(() => {
      item.style.opacity = '0';
      item.style.transform = 'translateY(-6px)';
      item.style.transition = 'opacity 200ms ease, transform 200ms ease';
    }, 3000);
    window.setTimeout(() => item.remove(), 3300);
  }

  private showVictory(kills: number, gold: number) {
    this.ui.winStats.innerHTML = `<div>Kills: ${kills}</div><div>Gold: ${gold}</div>`;
    this.ui.winScreen.style.display = 'flex';
  }

  private toggleMap(force?: boolean) {
    const next = force ?? !this.mapOpen;
    this.mapOpen = next;
    this.ui.mapOverlay.classList.toggle('visible', next);
    if (next) {
      this.ui.scopeOverlay.style.display = 'none';
      this.drawMaps();
    }
  }

  private setLoading(percent: number, text: string) {
    this.ui.loadingBar.style.width = `${percent}%`;
    this.ui.loadingText.textContent = text;
  }

  private getSocketUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws`;
  }

  private getLocalPlayer(): Player | null {
    if (!this.state || !this.localPlayerId) return null;
    return this.playersById.get(this.localPlayerId) ?? null;
  }

  private getTrackedShip(): Ship | null {
    if (!this.state) return null;

    const player = this.getLocalPlayer();
    if (player?.onShipId) {
      return this.shipsById.get(player.onShipId) ?? null;
    }
    if (this.localShipId) {
      return this.shipsById.get(this.localShipId) ?? null;
    }
    return null;
  }

  private getTrackedShipFromState(state: GameState): Ship | null {
    const player = this.localPlayerId
      ? state.players.find((candidate) => candidate.id === this.localPlayerId)
      : null;
    if (player?.onShipId) {
      return state.ships.find((ship) => ship.id === player.onShipId) ?? null;
    }
    if (this.localShipId) {
      return state.ships.find((ship) => ship.id === this.localShipId) ?? null;
    }
    return null;
  }

  private getActiveTradeSession(state: GameState): TradeSession | null {
    if (!this.localPlayerId) return null;
    return state.tradeSessions.find((session) =>
      session.initiatorId === this.localPlayerId ||
      session.targetPlayerId === this.localPlayerId ||
      session.initiatorShipId === this.localShipId ||
      session.targetShipId === this.localShipId
    ) ?? null;
  }

  private distance2D(ax: number, az: number, bx: number, bz: number) {
    const dx = ax - bx;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private getInventoryQty(ship: Ship | null, item: ItemStack['item']) {
    if (!ship) return 0;
    return ship.inventory.find((entry) => entry.item === item)?.qty ?? 0;
  }

  private getRepairPlankCount(player: Player, ship: Ship | null) {
    return player.pocketWood + this.getInventoryQty(ship, 'wood_plank');
  }

  private formatTradeItem(entry: ItemStack) {
    return `${entry.qty} ${entry.item.replace(/_/g, ' ')}`;
  }

  private cloneOffer(offer: ItemStack[]) {
    return offer.map((entry) => ({ ...entry }));
  }

  private getCutlassSwingProgress(player: Player) {
    const activeWeapon = player.atCannon || player.atHelm || player.atSails || player.atCrowNest ? null : player.weapons[player.activeSlot];
    if (!activeWeapon || activeWeapon.weaponId !== 'cutlass' || !activeWeapon.reloading) {
      return 0;
    }
    return 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / WEAPONS.cutlass.reloadTime, 0, 1);
  }

  private syncHeldWeapon(mesh: THREE.Group, player: Player) {
    const rightHand = mesh.getObjectByName('right-hand');
    if (!rightHand) return;

    const activeWeapon = player.atCannon || player.atHelm || player.atSails || player.atCrowNest ? null : player.weapons[player.activeSlot];
    const currentId = activeWeapon?.weaponId ?? null;
    const existing = rightHand.getObjectByName('held-weapon') as THREE.Group | null;
    const useLocalSwimViewmodel = player.id === this.localPlayerId;

    if (!currentId || currentId === 'ship_cannon' || useLocalSwimViewmodel || player.state === 'eliminated' || player.state === 'respawning') {
      existing?.removeFromParent();
      return;
    }

    let weaponMesh = existing;
    if (!weaponMesh || mesh.userData.heldWeaponId !== currentId) {
      existing?.removeFromParent();
      weaponMesh = makeHeldWeaponMesh(currentId);
      weaponMesh.name = 'held-weapon';
      rightHand.add(weaponMesh);
      mesh.userData.heldWeaponId = currentId;
    }

    switch (currentId) {
      case 'cutlass':
        {
          const swingProgress = this.getCutlassSwingProgress(player);
          const slashArc = Math.sin(THREE.MathUtils.clamp((swingProgress - 0.18) / 0.42, 0, 1) * Math.PI);
          const recover = THREE.MathUtils.smoothstep(swingProgress, 0.6, 1);
          weaponMesh.position.set(
            0.04 + slashArc * 0.12,
            0.02 + swingProgress * 0.05,
            0.12 + slashArc * 0.16,
          );
          weaponMesh.rotation.set(
            -0.06 - slashArc * 0.7 + recover * 0.14,
            0.12 + slashArc * 0.28,
            -0.62 + slashArc * 0.92 - recover * 0.16,
          );
        }
        break;
      case 'eye_of_reach':
        if (player.state === 'swimming') {
          weaponMesh.position.set(0.06, -0.04, 0.38);
          weaponMesh.rotation.set(-Math.PI * 0.42, Math.PI * 0.08, -Math.PI * 0.12);
        } else {
          weaponMesh.position.set(0.03, 0.06, 0.14);
          weaponMesh.rotation.set(-Math.PI * 0.28, Math.PI * 0.06, -Math.PI * 0.08);
        }
        break;
      case 'blunderbuss':
        if (player.state === 'swimming') {
          weaponMesh.position.set(0.08, -0.05, 0.3);
          weaponMesh.rotation.set(-Math.PI * 0.36, Math.PI * 0.12, -Math.PI * 0.1);
        } else {
          weaponMesh.position.set(0.02, 0.04, 0.1);
          weaponMesh.rotation.set(-Math.PI * 0.22, Math.PI * 0.08, -Math.PI * 0.06);
        }
        break;
      default:
        if (player.state === 'swimming') {
          weaponMesh.position.set(0.09, -0.08, 0.24);
          weaponMesh.rotation.set(-Math.PI * 0.34, Math.PI * 0.16, -Math.PI * 0.2);
        } else {
          weaponMesh.position.set(0.04, 0.02, 0.04);
          weaponMesh.rotation.set(-Math.PI * 0.08, Math.PI * 0.1, -Math.PI * 0.12);
        }
        break;
    }
  }

  /** First-person preview of held supplies and powder kegs before use. */
  private syncLocalViewPocket(): boolean {
    const player = this.getLocalPlayer();
    if (!player || player.state === 'eliminated' || player.state === 'respawning') {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    if (player.atCannon || player.atHelm || player.atSails || player.atCrowNest) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    if (this.input.isKegPreviewActive() && player.kegs > 0) {
      const kind: PocketPreviewKind = 'powder_keg';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.55);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }

      const time = this.ocean.getTime();
      const moveAxes = this.input.getMoveAxes();
      const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
      const bob = Math.sin(time * (4.7 + moveAmount * 2.1)) * (0.005 + moveAmount * 0.013);
      const sway = Math.sin(time * (2.5 + moveAmount * 1.3)) * (0.006 + moveAmount * 0.012);

      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(-0.1 + sway * 0.38, -0.46 + bob, -0.84);
      this.localViewPocketRoot.rotation.set(-0.13 + bob * 0.9, 0.18 + sway * 0.35, 0.04);
      return true;
    }
    const digChest = player.nearChestId ? this.findChestById(player.nearChestId) : null;
    const digging =
      !!digChest
      && player.hasShovel
      && this.input.isInteractHeld()
      && !player.carryingChestId
      && digChest.buried
      && digChest.digProgress < 1;
    if (digging) {
      const kind: PocketPreviewKind = 'shovel';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.55);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      const time = this.ocean.getTime();
      const chop = Math.sin(time * 11.5) * 0.035;
      const scoop = Math.max(0, Math.sin(time * 5.8)) * 0.22;
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(-0.22, -0.42 - scoop * 0.12 + chop, -0.6 + scoop * 0.18);
      this.localViewPocketRoot.rotation.set(-0.7 - scoop * 0.95, 0.18, -0.18 + scoop * 0.18);
      return true;
    }
    if (this.pocketUsePreviewTimer > 0) {
      this.pocketUsePreviewTimer = Math.max(0, this.pocketUsePreviewTimer - this.frameDt);
    } else {
      this.pocketUsePreviewKind = null;
    }

    const usingPreview = this.pocketUsePreviewKind !== null && this.pocketUsePreviewTimer > 0;
    if (!this.input.isSupplyWheelOpen() && !usingPreview) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    const slot = this.input.getSupplyWheelHeldSlot();
    if (slot === null && !usingPreview) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    const counts = [player.pocketBanana, player.pocketWood, player.pocketCoconut, player.pocketMango] as const;
    const kinds: PocketPreviewKind[] = ['banana', 'wood', 'coconut', 'mango'];
    const kind = usingPreview ? this.pocketUsePreviewKind! : kinds[slot!];
    if (!usingPreview && counts[slot!] <= 0) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
    if (!mesh || this.localViewPocketKind !== kind) {
      this.localViewPocketRoot.clear();
      mesh = makePocketPreviewMesh(kind);
      mesh.name = 'local-pocket';
      mesh.rotation.y = Math.PI;
      mesh.scale.setScalar(1.35);
      applyViewmodelMaterialSettings(mesh);
      this.localViewPocketRoot.add(mesh);
      this.localViewPocketKind = kind;
    }

    const time = this.ocean.getTime();
    const moveAxes = this.input.getMoveAxes();
    const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
    const bob = Math.sin(time * (5.2 + moveAmount * 2.2)) * (0.006 + moveAmount * 0.014);
    const sway = Math.sin(time * (2.8 + moveAmount * 1.4)) * (0.005 + moveAmount * 0.01);
    const previewDuration = kind === 'wood' ? 0.45 : 0.82;
    const eatProgress = usingPreview
      ? 1 - THREE.MathUtils.clamp(this.pocketUsePreviewTimer / previewDuration, 0, 1)
      : 0;
    const biteArc = Math.sin(eatProgress * Math.PI);
    const toMouth = kind === 'wood' ? 0 : THREE.MathUtils.smoothstep(eatProgress, 0.1, 0.72);

    this.localViewPocketRoot.visible = true;
    this.localViewPocketRoot.position.set(
      -0.34 + sway * 0.5 + toMouth * 0.22,
      -0.38 + bob + toMouth * 0.3 + biteArc * 0.035,
      -0.52 + toMouth * 0.22,
    );
    this.localViewPocketRoot.rotation.set(
      -0.12 + bob * 1.2 - toMouth * 0.46,
      0.22 + sway * 0.4 + toMouth * 0.22,
      0.08 + biteArc * 0.12,
    );
    return true;
  }

  private syncLocalViewWeapon() {
    if (this.syncLocalViewPocket()) {
      this.localViewWeaponRoot.visible = false;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      return;
    }

    const player = this.getLocalPlayer();
    const activeWeapon = player?.atCannon || player?.atHelm || player?.atSails || player?.atCrowNest ? null : player?.weapons[player.activeSlot] ?? null;
    if (!player || !activeWeapon || activeWeapon.weaponId === 'ship_cannon' || player.state === 'eliminated' || player.state === 'respawning') {
      this.localViewWeaponRoot.visible = false;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      return;
    }
    const weaponId = activeWeapon.weaponId;

    let weaponMesh = this.localViewWeaponRoot.getObjectByName('local-view-weapon') as THREE.Group | null;
    if (!weaponMesh || this.localViewWeaponId !== weaponId) {
      this.localViewWeaponRoot.clear();
      weaponMesh = makeHeldWeaponMesh(weaponId);
      weaponMesh.name = 'local-view-weapon';
      weaponMesh.rotation.y = Math.PI;
      weaponMesh.scale.setScalar(weaponId === 'blunderbuss' ? 1.0 : 1.2);
      applyViewmodelMaterialSettings(weaponMesh);
      this.localViewWeaponRoot.add(weaponMesh);
      this.localViewWeaponId = weaponId;
    }

    const firearmEquipped = !WEAPONS[weaponId].melee;
    const aimBlend = firearmEquipped && this.input.isAiming() ? 1 : 0;
    const time = this.ocean.getTime();
    const moveAxes = this.input.getMoveAxes();
    const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
    const bob = Math.sin(time * (6.4 + moveAmount * 2.8)) * (0.004 + moveAmount * 0.012);
    const sway = Math.sin(time * (3.2 + moveAmount * 1.6)) * (0.004 + moveAmount * 0.01);
    const strafeTilt = moveAxes.x * (0.008 + moveAmount * 0.018);
    const travelSwing = Math.cos(time * (5.2 + moveAmount * 2.5)) * moveAmount * 0.016;
    const ammoSignature = `${weaponId}:${activeWeapon.ammo}:${activeWeapon.reloading ? 1 : 0}`;
    if (this.localViewWeaponAmmoSignature && ammoSignature !== this.localViewWeaponAmmoSignature && activeWeapon.reloading) {
      this.localViewWeaponKick = Math.min(1.25, this.localViewWeaponKick + 0.24);
    }
    this.localViewWeaponAmmoSignature = ammoSignature;
    const kickTarget = firearmEquipped && this.input.isFiring() && !activeWeapon.reloading ? 0.72 : 0;
    this.localViewWeaponKick += (kickTarget - this.localViewWeaponKick) * Math.min(1, this.frameDt * (kickTarget > this.localViewWeaponKick ? 18 : 13));
    const reloadBlend = activeWeapon.reloading
      ? 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / Math.max(0.001, WEAPONS[weaponId].reloadTime), 0, 1)
      : 0;
    if (activeWeapon.reloading) {
      this.localViewWeaponReloadPhase = reloadBlend;
    } else {
      this.localViewWeaponReloadPhase += (0 - this.localViewWeaponReloadPhase) * Math.min(1, this.frameDt * 10);
    }
    const reloadArc = Math.sin(this.localViewWeaponReloadPhase * Math.PI);
    const recoilBack = this.localViewWeaponKick * 0.12;
    const recoilLift = this.localViewWeaponKick * 0.045;
    const recoilRoll = this.localViewWeaponKick * 0.055;

    this.localViewWeaponRoot.visible = true;

    switch (weaponId) {
      case 'eye_of_reach':
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.28, 0.025, aimBlend) + sway * 0.38 + travelSwing * 0.26 + reloadArc * 0.08,
          THREE.MathUtils.lerp(-0.2, -0.15, aimBlend) + bob - recoilLift - reloadArc * 0.05,
          THREE.MathUtils.lerp(-0.62, -0.42, aimBlend) - recoilBack + reloadArc * 0.08,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.14 - aimBlend * 0.12 - recoilLift * 1.2 + reloadArc * 0.22,
          -0.16 + aimBlend * 0.11 - reloadArc * 0.28,
          -0.03 - strafeTilt - recoilRoll + reloadArc * 0.12,
        );
        break;
      case 'blunderbuss':
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.28, 0.06, aimBlend) + sway * 0.36 + travelSwing * 0.28 + reloadArc * 0.08,
          THREE.MathUtils.lerp(-0.24, -0.17, aimBlend) + bob - recoilLift * 0.8 - reloadArc * 0.06,
          THREE.MathUtils.lerp(-0.74, -0.52, aimBlend) - recoilBack * 0.72 + reloadArc * 0.1,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.24 - aimBlend * 0.07 - recoilLift + reloadArc * 0.28,
          -0.18 + aimBlend * 0.12 - reloadArc * 0.34,
          -0.08 - strafeTilt - recoilRoll * 0.8 + reloadArc * 0.14,
        );
        break;
      case 'cutlass':
        this.localViewWeaponRoot.position.set(
          0.3 + sway * 0.28 + travelSwing * 0.52,
          -0.3 + bob * 0.9 - reloadArc * 0.1,
          -0.58 + reloadArc * 0.08,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.02 + reloadArc * 0.48,
          -0.28 - reloadArc * 0.18,
          -0.82 - strafeTilt * 1.6 - reloadArc * 0.95,
        );
        break;
      default:
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.31, 0.085, aimBlend) + sway * 0.64 + travelSwing * 0.38 + reloadArc * 0.07,
          THREE.MathUtils.lerp(-0.24, -0.17, aimBlend) + bob - recoilLift * 0.62 - reloadArc * 0.05,
          THREE.MathUtils.lerp(-0.6, -0.4, aimBlend) - recoilBack * 0.8 + reloadArc * 0.06,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.2 - aimBlend * 0.07 - recoilLift + reloadArc * 0.24,
          -0.18 + aimBlend * 0.14 - reloadArc * 0.22,
          -0.1 - strafeTilt - recoilRoll + reloadArc * 0.12,
        );
        break;
    }

    // Eye of Reach: keep the 3D scope tube (classic look). Hide stock/barrel/grip while ADS; counter-scale so narrow scope FOV does not balloon the viewmodel.
    if (weaponId === 'eye_of_reach' && weaponMesh) {
      const adsScope = this.input.isAiming() && !activeWeapon.reloading;
      const HIP_FOV = 74;
      const adsFov = WEAPONS.eye_of_reach.scopeFov ?? 14;
      let usedScopedFlags = false;
      weaponMesh.traverse((part) => {
        if (part.userData.eorHideInScope === true) {
          part.visible = !adsScope;
          usedScopedFlags = true;
        } else if (part.userData.eorKeepInScope === true) {
          part.visible = true;
          usedScopedFlags = true;
        }
      });
      if (!usedScopedFlags) {
        for (const partId of ['vm-eor-grip', 'vm-eor-stock', 'vm-eor-barrel', 'vm-eor-butt'] as const) {
          const part = weaponMesh.getObjectByName(partId);
          if (part) part.visible = !adsScope;
        }
        const scopePart = weaponMesh.getObjectByName('vm-eor-scope');
        if (scopePart) scopePart.visible = true;
      }
      if (adsScope) {
        const hipHalf = THREE.MathUtils.degToRad(HIP_FOV * 0.5);
        const adsHalf = THREE.MathUtils.degToRad(adsFov * 0.5);
        this.localViewWeaponRoot.scale.setScalar(Math.tan(adsHalf) / Math.tan(hipHalf));
      } else {
        this.localViewWeaponRoot.scale.setScalar(1);
      }
    } else {
      this.localViewWeaponRoot.scale.setScalar(1);
    }
  }

  private getLookInteraction(
    player: Player,
    ship: Ship | null,
    nearbyCannon: number | null,
    repairSection: keyof Ship['hull'] | null,
  ): { prompt: string; label: string; kind: InteractIntent } | null {
    const candidates: Array<{ prompt: string; label: string; score: number; kind: InteractIntent }> = [];

    const mermaidShip = this.getMermaidReturnShip(player);
    if (mermaidShip) {
      candidates.push({
        prompt: '[X] Return To Ship',
        label: 'Mermaid ferry waiting nearby',
        score: 1.8,
        kind: 'mermaid',
      });
    }

    if (player.nearBarrelId) {
      const barrelPos = this.getBarrelWorldPoint(player.nearBarrelId);
      if (barrelPos) {
        this.pushInteractionCandidate(candidates, player, barrelPos, 5.5, 0.72, '[X] Open Barrel', 'Island supplies', 'barrel');
      }
    }

    const nearbyGoldHoarder = this.getNearbyGoldHoarder(player);
    if (nearbyGoldHoarder) {
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(nearbyGoldHoarder.npc.position.x, nearbyGoldHoarder.npc.position.y + 1.05, nearbyGoldHoarder.npc.position.z),
        4.6,
        0.2,
        player.carryingChestId ? '[X] Sell Chest' : '[X] Get Treasure Map',
        player.carryingChestId
          ? `Gold Hoarder pays toward ${ECONOMY.GOLD_WIN_TARGET}`
          : 'Gold Hoarder chart marks buried treasure',
        'gold_hoarder',
      );
    }

    if (player.nearChestId && !player.carryingChestId) {
      const chestPos = this.getChestWorldPoint(player.nearChestId);
      const chest = this.findChestById(player.nearChestId);
      if (chestPos && chest && chest.carriedByPlayerId !== player.id) {
        const digging = chest.buried && chest.digProgress < 1;
        const prompt = digging
          ? (player.hasShovel ? '[Hold X] Dig' : 'Find a shovel')
          : chest.carriedByPlayerId
            ? '[X] Steal Chest'
            : chest.storedOnShipId
              ? '[X] Take Chest'
              : chest.floating
                ? '[X] Grab Floating Chest'
                : '[X] Pick Up Chest';
        const label = digging
          ? `Buried treasure · ${Math.round(chest.digProgress * 100)}% dug`
          : `Worth ${chest.value} gold at Gold Hoarder`;
        this.pushInteractionCandidate(candidates, player, chestPos, 5.5, 0.72, prompt, label, 'chest');
      }
    }

    if (!player.onShipId && player.nearShipId && this.state) {
      const targetShip = this.state.ships.find((candidate) => candidate.id === player.nearShipId && candidate.alive);
      if (targetShip) {
        const ladder = getNearestShipBoardingLadder(targetShip, player.position);
        if (ladder) {
          const boardPoint = new THREE.Vector3(ladder.x, targetShip.position.y + SHIP_STATS[targetShip.type].height * 0.56, ladder.z);
          this.pushInteractionCandidate(candidates, player, boardPoint, 3.2, 0.4, '[X] Climb Ladder', 'Board from the side ladder', 'board');
        }
      }
    }

    if (player.state === 'swimming' && this.state) {
      for (const isl of this.state.islands) {
        if (!isl.dock) continue;
        const dock = isl.dock;
        const dx = player.position.x - dock.position.x;
        const dz = player.position.z - dock.position.z;
        const cos = Math.cos(dock.rotation);
        const sin = Math.sin(dock.rotation);
        const localX = dx * cos + dz * sin;
        const localZ = -dx * sin + dz * cos;
        if (Math.abs(localX) > dock.width * 0.42) continue;
        if (localZ > -dock.length * 0.08 || localZ < -dock.length * 0.58) continue;
        const ladderPoint = getIslandDockSwimLadderPoint(dock);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(ladderPoint.x, ladderPoint.y, ladderPoint.z),
          4.2,
          0.45,
          '[X] Climb Dock Ladder',
          'Swim up to the wooden dock',
          'dock',
        );
      }
    }

    if (ship) {
      if (player.carryingChestId && player.onShipId === ship.id) {
        const stats = SHIP_STATS[ship.type];
        const stowPoint = this.getShipWorldPoint(ship, 0, -stats.length * 0.22, stats.height + 0.7);
        this.pushInteractionCandidate(
          candidates,
          player,
          stowPoint,
          4.8,
          0.16,
          '[X] Stow Chest',
          'Place chest on deck for the crew',
          'stow_chest',
        );
      }

      const nearbyKeg = this.findNearbyKeg(player, ship);
      if (nearbyKeg) {
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(nearbyKeg.position.x, nearbyKeg.position.y + 0.45, nearbyKeg.position.z),
          3,
          0.3,
          '[X] Defuse Powder Keg',
          `${Math.max(1, Math.ceil(nearbyKeg.timer))}s until detonation`,
          'keg_diffuse',
        );
      }

      const nearbyStation = this.getNearbyUpgradeStation(player);
      if (
        nearbyStation
        && nearbyStation.claimedByShipId !== ship.id
        && !ship.upgrades.some((upgrade) => upgrade.type === nearbyStation.type)
      ) {
        const meta = this.getUpgradePresentation(nearbyStation.type);
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(nearbyStation.position.x, nearbyStation.position.y + 0.9, nearbyStation.position.z),
          4.4,
          0.2,
          `[X] Claim ${meta.name}`,
          `Upgrade station · ${meta.effect}`,
          'upgrade',
        );
      }

      if (this.isNearHelm(player, ship)) {
        const helmPoint = this.getShipWorldPoint(ship, 0, -SHIP_STATS[ship.type].length * 0.37, SHIP_STATS[ship.type].height + 0.95);
        this.pushInteractionCandidate(candidates, player, helmPoint, 3.6, 0.6, '[X] Take Helm', 'A/D or arrows turn · W/S trims sails', 'helm');
      }

      if (this.isNearSailStation(player, ship)) {
        const sailControl = this.getSailControlLocal(SHIP_STATS[ship.type]);
        const sailPoint = this.getShipWorldPoint(ship, sailControl.x, sailControl.z, SHIP_STATS[ship.type].height + 0.85);
        this.pushInteractionCandidate(
          candidates,
          player,
          sailPoint,
          3.4,
          0.45,
          '[X] Use Sail Ring',
          'C/Z hoist sails · Q/F angle sails',
          'sails',
        );
      }

      if (this.isNearCrowNestLadder(player, ship)) {
        const stats = SHIP_STATS[ship.type];
        const mastZ = getMainMastLocalZ(stats);
        const ladderPoint = this.getShipWorldPoint(ship, 0, mastZ, stats.height + 1.15);
        this.pushInteractionCandidate(
          candidates,
          player,
          ladderPoint,
          3.2,
          0.24,
          'Press X to Climb Crow\'s Nest',
          'Main mast ladder · spotting platform above',
          'crow',
        );
      }

      if (this.isNearAnchor(player, ship)) {
        const anchorLocal = this.getAnchorControlLocal(SHIP_STATS[ship.type]);
        const anchorPoint = this.getShipWorldPoint(ship, anchorLocal.x, anchorLocal.z, SHIP_STATS[ship.type].height + 0.45);
        const anchorProgress = Math.round((ship.anchorRaiseProgress ?? 0) * 100);
        this.pushInteractionCandidate(
          candidates,
          player,
          anchorPoint,
          3.8,
          0.58,
          ship.anchored ? `[Hold X] Raise Anchor ${anchorProgress}%` : '[X] Drop Anchor',
          ship.anchored ? 'Turn the capstan wheel to raise' : 'Drop anchor to stop fast',
          'anchor',
        );
      }

      if (repairSection) {
        const repairPoint = this.getRepairWorldPoint(ship, repairSection);
        const plankCount = this.getRepairPlankCount(player, ship);
        this.pushInteractionCandidate(
          candidates,
          player,
          repairPoint,
          4.5,
          0.52,
          plankCount > 0
            ? `[X] Repair ${repairSection[0].toUpperCase()}${repairSection.slice(1)}`
            : `⚠ Damaged ${repairSection[0].toUpperCase()}${repairSection.slice(1)}`,
          plankCount > 0
            ? `${plankCount} plank${plankCount === 1 ? '' : 's'} ready`
            : 'No planks ready',
          'repair',
        );
      }

      if (nearbyCannon !== null) {
        const cannonPoint = this.shipRenderer.getCannonWorldPos(ship.id, nearbyCannon)
          ?? this.getShipWorldPoint(
            ship,
            nearbyCannon < Math.max(1, SHIP_STATS[ship.type].cannonCount / 2)
              ? SHIP_STATS[ship.type].width * 0.6
              : -SHIP_STATS[ship.type].width * 0.6,
            0,
            SHIP_STATS[ship.type].height + 0.2,
          );
        this.pushInteractionCandidate(
          candidates,
          player,
          cannonPoint,
          4.2,
          0.52,
          '[X] Use Cannon',
          `Broadside cannon ${nearbyCannon + 1} · [4/5/6] ammo`,
          'cannon',
        );
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ?? null;
  }

  private pushInteractionCandidate(
    candidates: Array<{ prompt: string; label: string; score: number; kind: InteractIntent }>,
    player: Player,
    point: THREE.Vector3,
    maxDistance: number,
    minDot: number,
    prompt: string,
    label: string,
    kind: InteractIntent,
  ) {
    const eyePos = new THREE.Vector3(player.position.x, player.position.y + PLAYER.HEIGHT * 0.72, player.position.z);
    const toPoint = point.clone().sub(eyePos);
    const distance = toPoint.length();
    if (distance > maxDistance) return;

    const lookDir = this.getLookDirection(player);
    const dot = toPoint.normalize().dot(lookDir);
    if (dot < minDot) return;

    candidates.push({ prompt, label, score: dot - distance * 0.035, kind });
  }

  private getLookDirection(player: Player) {
    return new THREE.Vector3(
      Math.sin(player.rotation.x) * Math.cos(player.rotation.y),
      Math.sin(player.rotation.y),
      Math.cos(player.rotation.x) * Math.cos(player.rotation.y),
    ).normalize();
  }

  private getShipWorldPoint(ship: Ship, localX: number, localZ: number, worldY: number) {
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return new THREE.Vector3(
      ship.position.x + localX * cos + localZ * sin,
      ship.position.y + worldY,
      ship.position.z + localZ * cos - localX * sin,
    );
  }

  private getRepairWorldPoint(ship: Ship, section: keyof Ship['hull']) {
    const stats = SHIP_STATS[ship.type];
    switch (section) {
      case 'bow':
        return this.getShipWorldPoint(ship, 0, stats.length * 0.44, stats.height + 0.4);
      case 'stern':
        return this.getShipWorldPoint(ship, 0, -stats.length * 0.42, stats.height + 0.4);
      case 'port':
        return this.getShipWorldPoint(ship, -stats.width * 0.54, 0, stats.height + 0.4);
      case 'starboard':
      default:
        return this.getShipWorldPoint(ship, stats.width * 0.54, 0, stats.height + 0.4);
    }
  }

  private getCannonSide(cannonIndex: number, ship: Ship) {
    return cannonIndex < Math.max(1, SHIP_STATS[ship.type].cannonCount / 2) ? 1 : -1;
  }

  private getCannonAim(ship: Ship, cannonIndex: number, yaw: number, pitch: number) {
    const broadsideYaw = ship.rotation + (this.getCannonSide(cannonIndex, ship) > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
    return {
      yaw: broadsideYaw + THREE.MathUtils.clamp(angleWrap(yaw - broadsideYaw), -SHIP.CANNON_YAW_ARC, SHIP.CANNON_YAW_ARC),
      pitch: THREE.MathUtils.clamp(pitch, SHIP.CANNON_PITCH_MIN, SHIP.CANNON_PITCH_MAX),
    };
  }

  private findNearbyKeg(player: Player, ship: Ship): ShipKeg | null {
    if (!this.state) return null;
    let closest: ShipKeg | null = null;
    let closestDistance: number = SHIP.KEG_DIFFUSE_RANGE;
    for (const keg of this.state.kegs) {
      if (keg.shipId !== ship.id || keg.timer <= 0) continue;
      const dx = player.position.x - keg.position.x;
      const dy = player.position.y - keg.position.y;
      const dz = player.position.z - keg.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = keg;
      }
    }
    return closest;
  }

  private getNearbyUpgradeStation(player: Player): UpgradeStation | null {
    if (!this.state) return null;
    let closest: UpgradeStation | null = null;
    let closestDistance: number = PLAYER.INTERACT_RANGE;
    for (const island of this.state.islands) {
      for (const station of island.upgradeStations) {
        const dx = player.position.x - station.position.x;
        const dz = player.position.z - station.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = station;
        }
      }
    }
    return closest;
  }

  private getNearbyGoldHoarder(player: Player): { npc: IslandNpc; island: Island } | null {
    if (!this.state) return null;
    let closest: { npc: IslandNpc; island: Island; distance: number } | null = null;
    for (const island of this.state.islands) {
      for (const npc of island.npcs) {
        if (npc.role !== 'gold_hoarder') continue;
        const distance = this.distance2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
        if (distance < PLAYER.INTERACT_RANGE + 0.85 && (!closest || distance < closest.distance)) {
          closest = { npc, island, distance };
        }
      }
    }
    return closest ? { npc: closest.npc, island: closest.island } : null;
  }

  private getClosestGoldHoarder(player: Player): { npc: IslandNpc; island: Island; distance: number } | null {
    if (!this.state) return null;
    let closest: { npc: IslandNpc; island: Island; distance: number } | null = null;
    for (const island of this.state.islands) {
      for (const npc of island.npcs) {
        if (npc.role !== 'gold_hoarder') continue;
        const distance = this.distance2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
        if (!closest || distance < closest.distance) {
          closest = { npc, island, distance };
        }
      }
    }
    return closest;
  }

  private getMermaidReturnShip(player: Player): Ship | null {
    if (!this.state || player.state !== 'swimming' || !player.shipId) return null;
    const homeShip = this.state.ships.find((ship) => ship.id === player.shipId && ship.alive && !ship.sinking) ?? null;
    if (!homeShip) return null;
    return this.distance2D(player.position.x, player.position.z, homeShip.position.x, homeShip.position.z) >= 45
      ? homeShip
      : null;
  }

  private findChestById(chestId: string): TreasureChest | null {
    if (!this.state) return null;
    for (const island of this.state.islands) {
      const chest = island.chests.find((candidate) => candidate.id === chestId);
      if (chest) return chest;
    }
    return null;
  }

  private getChestWorldPoint(chestId: string) {
    if (!this.state) return null;
    for (const island of this.state.islands) {
      const chest = island.chests.find((candidate) => candidate.id === chestId);
      if (chest) {
        const y = chest.buried && chest.digProgress < 1
          ? getIslandSurfaceY(island, chest.position.x, chest.position.z) + 0.35
          : chest.position.y + 0.8;
        return new THREE.Vector3(chest.position.x, y, chest.position.z);
      }
    }
    return null;
  }

  private getBarrelWorldPoint(barrelId: string) {
    if (!this.state) return null;
    for (const island of this.state.islands) {
      const barrel = island.barrels.find((b) => b.id === barrelId);
      if (barrel) {
        return new THREE.Vector3(barrel.position.x, barrel.position.y + 0.55, barrel.position.z);
      }
    }
    return null;
  }

  private getNearestIsland(px: number, pz: number): Island | null {
    if (!this.state) return null;
    let best: Island | null = null;
    let bestD = Infinity;
    for (const island of this.state.islands) {
      const dx = px - island.position.x;
      const dz = pz - island.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestD) {
        bestD = d;
        best = island;
      }
    }
    return best;
  }

  private flashIslandBanner(name: string) {
    this.ui.islandBanner.innerHTML = `<div class="ib-title">${name}</div><div class="ib-sub">Land discovered</div>`;
    this.ui.islandBanner.classList.add('visible');
    this.islandBannerHideAt = performance.now() + 4500;
  }

  private playIslandArrivalFanfare() {
    try {
      const win = window as unknown as { webkitAudioContext?: typeof AudioContext };
      const Ctx = window.AudioContext || win.webkitAudioContext;
      if (!Ctx) return;
      const ctx = this.islandArrivalAudioCtx ?? new Ctx();
      this.islandArrivalAudioCtx = ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 987.77];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, now + i * 0.11);
        g.gain.linearRampToValueAtTime(0.065, now + i * 0.11 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.38);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(now + i * 0.11);
        o.stop(now + i * 0.11 + 0.42);
      });
    } catch {
      /* Web Audio optional */
    }
  }

  private animatePlayerMesh(mesh: THREE.Group, player: Player, ship: Ship | null, dt: number) {
    const animation = mesh.userData.animation as {
      phase: number;
      parts?: Record<string, THREE.Object3D>;
    };
    const parts = animation?.parts;
    if (!parts) return;

    const torso = parts.torso;
    const shirt = parts.shirt;
    const pelvis = parts.pelvis;
    const coatSkirt = parts['coatSkirt'] ?? parts['coat-skirt'];
    const leftArmPivot = parts['leftArmPivot'] ?? parts['left-arm-pivot'];
    const rightArmPivot = parts['rightArmPivot'] ?? parts['right-arm-pivot'];
    const leftLegPivot = parts['leftLegPivot'] ?? parts['left-leg-pivot'];
    const rightLegPivot = parts['rightLegPivot'] ?? parts['right-leg-pivot'];
    const head = parts.head;
    const hair = parts.hair;
    const bandana = parts.bandana;
    if (!torso || !shirt || !pelvis || !leftArmPivot || !rightArmPivot || !leftLegPivot || !rightLegPivot || !head || !hair || !bandana) {
      return;
    }

    const moveSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    const moveRatio = Math.min(
      1,
      player.state === 'swimming'
        ? Math.max(0.38, moveSpeed / PLAYER.SWIM_SPEED)
        : moveSpeed / PLAYER.MOVE_SPEED,
    );
    const swimRate = player.state === 'swimming' ? 3.4 + moveRatio * 9.2 : 2.2 + moveRatio * 7.4;
    animation.phase = (animation.phase + dt * swimRate) % (Math.PI * 2);
    const phase = animation.phase;
    const deckSway = Math.sin(this.ocean.getTime() * 1.5 + mesh.position.x * 0.03 + mesh.position.z * 0.04) * 0.025;
    const walkSwing = Math.sin(phase) * 0.8 * moveRatio;
    const walkLift = Math.cos(phase * 2) * 0.05 * moveRatio;
    const idleBob = deckSway + Math.sin(this.ocean.getTime() * 2.1 + phase) * 0.018;
    const activeWeapon = player.atCannon || player.atHelm || player.atSails || player.atCrowNest ? null : player.weapons[player.activeSlot];
    const cutlassReady = activeWeapon?.weaponId === 'cutlass';
    const cutlassSwing = cutlassReady ? this.getCutlassSwingProgress(player) : 0;
    const firearmReady = !!activeWeapon && !WEAPONS[activeWeapon.weaponId].melee;
    const localSwimAim = player.id === this.localPlayerId && firearmReady && this.input.isAiming();

    torso.position.y = 1.28 + idleBob + walkLift * 0.35;
    shirt.position.y = 1.24 + idleBob + walkLift * 0.3;
    pelvis.position.y = 0.8 + idleBob * 0.35;
    head.position.y = 1.92 + idleBob * 0.9;
    hair.position.y = 2.0 + idleBob * 0.9;
    bandana.position.y = 2.0 + idleBob * 0.9;
    if (coatSkirt) {
      coatSkirt.position.y = 0.66 + idleBob * 0.2;
      coatSkirt.rotation.set(0, Math.sin(phase) * 0.1 * moveRatio, 0);
    }

    torso.rotation.set(0.04, 0, 0);
    pelvis.rotation.set(0, 0, 0);
    head.rotation.set(0, angleWrap(player.rotation.x - mesh.rotation.y) * 0.28, 0);
    hair.rotation.set(0, head.rotation.y, 0);
    bandana.rotation.set(Math.PI * 0.5, head.rotation.y, 0);

    if (player.atHelm) {
      const helmLean = ship ? THREE.MathUtils.clamp(ship.angularVelocity * 0.035, -0.18, 0.18) : 0;
      torso.rotation.x = 0.16;
      torso.rotation.z = helmLean;
      leftArmPivot.rotation.set(-1.15, 0, -0.48);
      rightArmPivot.rotation.set(-1.15, 0, 0.48);
      leftLegPivot.rotation.set(0.14, 0, 0.05);
      rightLegPivot.rotation.set(-0.08, 0, -0.05);
    } else if (player.atSails) {
      torso.rotation.x = 0.08;
      torso.rotation.z = -0.06;
      leftArmPivot.rotation.set(-0.74, 0.12, -0.34);
      rightArmPivot.rotation.set(-0.96, -0.06, 0.28);
      leftLegPivot.rotation.set(0.1, 0, 0.02);
      rightLegPivot.rotation.set(-0.06, 0, -0.02);
    } else if (player.atCrowNest) {
      torso.rotation.x = 0.02;
      torso.rotation.z = 0.04;
      leftArmPivot.rotation.set(-0.38, 0.06, -0.28);
      rightArmPivot.rotation.set(-0.42, -0.04, 0.26);
      leftLegPivot.rotation.set(0.14, 0, 0.06);
      rightLegPivot.rotation.set(-0.1, 0, -0.06);
    } else if (player.atCannon) {
      torso.rotation.x = 0.12;
      leftArmPivot.rotation.set(-0.9, 0, -0.18);
      rightArmPivot.rotation.set(-1.05, 0, 0.18);
      leftLegPivot.rotation.set(0.2, 0, 0);
      rightLegPivot.rotation.set(-0.16, 0, 0);
    } else if (player.state === 'swimming') {
      const swimPitch = THREE.MathUtils.clamp(player.rotation.y, -0.65, 0.65);
      const strokePhase = phase * 2.1;
      const kick = Math.sin(strokePhase);
      if (firearmReady) {
        const armStroke = localSwimAim ? 0.12 : 0.32;
        torso.rotation.x = -0.48 + swimPitch * 0.38 - (localSwimAim ? 0.08 : 0);
        torso.rotation.z = Math.sin(strokePhase * 0.8) * (localSwimAim ? 0.02 : 0.04);
        head.rotation.x = -swimPitch * 0.1;
        if (pelvis) pelvis.rotation.x = -0.18 + swimPitch * 0.08;
        leftArmPivot.rotation.set(-1.12 + Math.sin(strokePhase + Math.PI * 0.35) * armStroke, 0.08, -0.26);
        rightArmPivot.rotation.set(-0.82 - swimPitch * 0.22 - (localSwimAim ? 0.32 : 0.12), -0.08, 0.3);
        leftLegPivot.rotation.set(-0.34 - kick * 0.34, 0, -0.1);
        rightLegPivot.rotation.set(-0.34 + kick * 0.34, 0, 0.1);
      } else {
        torso.rotation.x = -0.42 + swimPitch * 0.32;
        torso.rotation.z = Math.sin(strokePhase * 0.9) * 0.05;
        head.rotation.x = -swimPitch * 0.12;
        if (pelvis) pelvis.rotation.x = -0.18 + swimPitch * 0.08;
        leftArmPivot.rotation.set(-1.52 + Math.sin(strokePhase) * 1.02, Math.sin(strokePhase) * 0.22, -0.24);
        rightArmPivot.rotation.set(-1.52 - Math.sin(strokePhase) * 1.02, -Math.sin(strokePhase) * 0.22, 0.24);
        leftLegPivot.rotation.set(-0.34 + Math.sin(strokePhase + Math.PI) * 0.34, 0, -0.08);
        rightLegPivot.rotation.set(-0.34 + Math.sin(strokePhase) * 0.34, 0, 0.08);
      }
    } else if (cutlassReady) {
      torso.rotation.x = 0.08;
      torso.rotation.y = -0.14;
      pelvis.rotation.y = 0.08;
      leftArmPivot.rotation.set(0.08 + walkSwing * 0.45, 0.08, 0.24);
      rightArmPivot.rotation.set(-0.42 - walkSwing * 0.18, -0.16, -0.38);
      leftLegPivot.rotation.set(-walkSwing * 1.05, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 1.05, 0, 0.04);
      torso.rotation.z = -walkSwing * 0.06;
    } else {
      const armRest = 0.2;
      leftArmPivot.rotation.set(armRest + walkSwing, 0, -0.12);
      rightArmPivot.rotation.set(armRest - walkSwing, 0, 0.12);
      leftLegPivot.rotation.set(-walkSwing * 1.15, 0, 0);
      rightLegPivot.rotation.set(walkSwing * 1.15, 0, 0);
      torso.rotation.z = walkSwing * 0.08;
    }

    if (cutlassReady && player.state !== 'swimming' && !player.atHelm && !player.atCannon && !player.atSails && !player.atCrowNest) {
      const windup = THREE.MathUtils.smoothstep(cutlassSwing, 0.02, 0.26);
      const strike = THREE.MathUtils.smoothstep(cutlassSwing, 0.18, 0.58);
      const recover = THREE.MathUtils.smoothstep(cutlassSwing, 0.62, 1);
      const slashArc = Math.sin(THREE.MathUtils.clamp((cutlassSwing - 0.18) / 0.4, 0, 1) * Math.PI);

      torso.rotation.x += windup * 0.08 - strike * 0.12 + recover * 0.03;
      torso.rotation.y += -windup * 0.58 + strike * 1.08 - recover * 0.28;
      torso.rotation.z += -windup * 0.18 + strike * 0.34 - recover * 0.08;
      pelvis.rotation.y += windup * 0.24 - strike * 0.2;
      head.rotation.y += -windup * 0.05 + strike * 0.14;
      hair.rotation.y = head.rotation.y;
      bandana.rotation.y = head.rotation.y;

      leftArmPivot.rotation.x = -0.18 + windup * 0.08 + strike * 0.42 - recover * 0.14;
      leftArmPivot.rotation.y = 0.1 - windup * 0.3 + strike * 0.58 - recover * 0.16;
      leftArmPivot.rotation.z = 0.32 - windup * 0.08 + strike * 0.18 - recover * 0.06;

      rightArmPivot.rotation.x = -0.62 - windup * 1.18 + strike * 1.72 + recover * 0.28;
      rightArmPivot.rotation.y = -0.16 - windup * 0.46 + strike * 1.16 - recover * 0.32;
      rightArmPivot.rotation.z = -0.42 - windup * 0.78 + strike * 1.95 - recover * 0.48;

      leftLegPivot.rotation.x -= slashArc * 0.08;
      rightLegPivot.rotation.x += slashArc * 0.12;
      leftLegPivot.rotation.z -= slashArc * 0.05;
      rightLegPivot.rotation.z += slashArc * 0.08;
    }
  }

  private animateSkeletonDeath(mesh: THREE.Group) {
    const animation = mesh.userData.animation as {
      phase: number;
      parts?: Record<string, THREE.Object3D>;
    };
    const parts = animation?.parts;
    if (!parts) return;

    const torso = parts.torso;
    const pelvis = parts.pelvis;
    const leftArmPivot = parts['leftArmPivot'] ?? parts['left-arm-pivot'];
    const rightArmPivot = parts['rightArmPivot'] ?? parts['right-arm-pivot'];
    const leftLegPivot = parts['leftLegPivot'] ?? parts['left-leg-pivot'];
    const rightLegPivot = parts['rightLegPivot'] ?? parts['right-leg-pivot'];
    const head = parts.head;
    if (!torso || !pelvis || !leftArmPivot || !rightArmPivot || !leftLegPivot || !rightLegPivot || !head) {
      return;
    }

    const deathTime = mesh.userData.deathTimer ?? 0;
    const settle = THREE.MathUtils.clamp(deathTime / 0.75, 0, 1);
    const collapse = THREE.MathUtils.smoothstep(settle, 0, 1);

    torso.rotation.set(-0.72 * collapse, 0.18 * collapse, 0.14 * collapse);
    pelvis.rotation.set(0.42 * collapse, 0.12 * collapse, -0.08 * collapse);
    head.rotation.set(0.4 * collapse, -0.22 * collapse, 0.18 * collapse);
    leftArmPivot.rotation.set(-1.9 * collapse, -0.4 * collapse, -1.05 * collapse);
    rightArmPivot.rotation.set(-1.2 * collapse, 0.3 * collapse, 1.25 * collapse);
    leftLegPivot.rotation.set(0.92 * collapse, 0, -0.42 * collapse);
    rightLegPivot.rotation.set(-0.28 * collapse, 0, 0.76 * collapse);
    torso.position.y = 1.28 - 0.55 * collapse;
    pelvis.position.y = 0.8 - 0.32 * collapse;
    head.position.y = 1.92 - 0.26 * collapse;
  }

  private initWindWisps() {
    if (this.windWispMeshes.length > 0) return;

    const geometry = new THREE.PlaneGeometry(3.1, 0.22);
    for (let index = 0; index < 16; index++) {
      const material = new THREE.MeshBasicMaterial({
        map: this.windWispTexture,
        color: 0xe5f7ff,
        transparent: true,
        opacity: 0.07 + Math.random() * 0.04,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.windWisps.add(mesh);
      this.windWispMeshes.push({
        mesh,
        radius: 1.6 + Math.random() * 7.5,
        height: 0.35 + Math.random() * 3.4,
        phase: Math.random(),
        speed: 0.16 + Math.random() * 0.18,
        sway: (Math.random() - 0.5) * 2.6,
        tilt: (Math.random() - 0.5) * 0.08,
      });
    }
  }

  private updateWindWisps() {
    const player = this.getLocalPlayer();
    if (!player) {
      this.windWisps.visible = false;
      return;
    }

    const trackedShip = this.getTrackedShip();
    const time = this.ocean.getTime();
    const wind = sampleWind(time);
    const dirX = Math.sin(wind.direction);
    const dirZ = Math.cos(wind.direction);
    const rightX = dirZ;
    const rightZ = -dirX;
    const shipDeckHeight = trackedShip ? SHIP_STATS[trackedShip.type].height : 0;
    const anchorX = trackedShip && player.onShipId === trackedShip.id ? trackedShip.position.x : player.position.x;
    const anchorY = trackedShip && player.onShipId === trackedShip.id
      ? trackedShip.position.y + shipDeckHeight + 1.1
      : player.position.y + PLAYER.HEIGHT * 0.6;
    const anchorZ = trackedShip && player.onShipId === trackedShip.id ? trackedShip.position.z : player.position.z;
    const laneLength = trackedShip ? SHIP_STATS[trackedShip.type].length * 0.95 : 10;
    this.windWisps.visible = true;

    for (const wisp of this.windWispMeshes) {
      const cycle = ((time * wisp.speed + wisp.phase) % 1 + 1) % 1;
      const along = (cycle - 0.5) * laneLength;
      const lateral = Math.sin(time * 0.85 + wisp.phase * Math.PI * 2) * wisp.radius + wisp.sway;
      const bob = Math.sin(time * 1.8 + wisp.phase * Math.PI * 4) * 0.2;
      wisp.mesh.position.set(
        anchorX + dirX * along + rightX * lateral,
        anchorY + wisp.height + bob,
        anchorZ + dirZ * along + rightZ * lateral,
      );
      wisp.mesh.rotation.set(wisp.tilt, wind.direction, 0);
      wisp.mesh.scale.set(0.86 + wind.strength * 0.78, 1 + wind.strength * 0.3, 1);
      const alpha = (0.055 + wind.strength * 0.085) * (1 - Math.abs(cycle - 0.5) * 1.05);
      (wisp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0.018, alpha);
    }
  }

  private toShipLocal(player: Player, ship: Ship) {
    const dx = player.position.x - ship.position.x;
    const dz = player.position.z - ship.position.z;
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return {
      x: dx * cos - dz * sin,
      z: dx * sin + dz * cos,
    };
  }

  private isNearHelm(player: Player, ship: Ship) {
    if (player.onShipId !== ship.id) return false;
    const local = this.toShipLocal(player, ship);
    return Math.abs(local.x) < 0.9 && Math.abs(local.z + SHIP_STATS[ship.type].length * 0.37) < 1.15;
  }

  private isNearSailStation(player: Player, ship: Ship) {
    if (player.onShipId !== ship.id) return false;
    const stats = SHIP_STATS[ship.type];
    if (player.position.y < ship.position.y + stats.height - 0.35) return false;
    const local = this.toShipLocal(player, ship);
    const station = this.getSailControlLocal(stats);
    return Math.abs(local.x - station.x) < 0.78 && Math.abs(local.z - station.z) < 0.92;
  }

  private isNearCrowNestLadder(player: Player, ship: Ship): boolean {
    if (player.onShipId !== ship.id) return false;
    const stats = SHIP_STATS[ship.type];
    const local = this.toShipLocal(player, ship);
    const { mastZ, maxAbsX, maxAbsZ } = getCrowNestLadderInteractionBounds(stats);
    const deckY = ship.position.y + stats.height + 0.1;
    return Math.abs(local.x) < maxAbsX
      && Math.abs(local.z - mastZ) < maxAbsZ
      && player.position.y >= deckY - 0.35
      && player.position.y < deckY + stats.height * 4.2;
  }

  private isNearAnchor(player: Player, ship: Ship) {
    if (player.onShipId !== ship.id) return false;
    const local = this.toShipLocal(player, ship);
    const anchor = this.getAnchorControlLocal(SHIP_STATS[ship.type]);
    return Math.abs(local.x - anchor.x) < 0.95 && Math.abs(local.z - anchor.z) < 1.0;
  }

  private getAnchorControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return {
      x: 0,
      z: stats.length * 0.42,
    };
  }

  private getSailControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return getSailStationLocal(stats);
  }

  private findRepairableHullSection(player: Player, ship: Ship): keyof Ship['hull'] | null {
    const local = this.toShipLocal(player, ship);
    const candidate: keyof Ship['hull'] =
      Math.abs(local.x) > Math.abs(local.z)
        ? (local.x >= 0 ? 'starboard' : 'port')
        : (local.z >= 0 ? 'bow' : 'stern');
    const closeEnough =
      candidate === 'bow' || candidate === 'stern'
        ? Math.abs(local.z) > SHIP_STATS[ship.type].length * 0.34
        : Math.abs(local.x) > SHIP_STATS[ship.type].width * 0.38;
    return closeEnough && ship.hull[candidate] < 0.98 ? candidate : null;
  }

  private findNearbyCannonIndex(player: Player, ship: Ship): number | null {
    if (player.onShipId !== ship.id) return null;

    const stats = SHIP_STATS[ship.type];
    const local = this.toShipLocal(player, ship);
    const cannonOffsetX = stats.width * 0.5 + 0.1;

    if (Math.abs(local.z) > stats.length * 0.35) return null;
    if (Math.abs(Math.abs(local.x) - cannonOffsetX) > 1.1) return null;

    const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
    const minZ = -stats.length * 0.3;
    const maxZ = stats.length * 0.2;
    const normalized = Math.max(0, Math.min(1, (maxZ - local.z) / Math.max(0.001, maxZ - minZ)));
    const slotWithinSide = cannonsPerSide === 1 ? 0 : Math.round(normalized * (cannonsPerSide - 1));
    const sideOffset = local.x >= 0 ? 0 : cannonsPerSide;

    return sideOffset + slotWithinSide;
  }

  private bindInteractPromptClick() {
    const el = this.ui.interactPrompt;
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.lastInteractKind = this.resolveCurrentInteractKind() ?? this.visibleInteractKind;
      this.pendingInteractFromUi = true;
      const t = el.textContent ?? '';
      if (t.includes('Launch')) {
        this.pendingLaunchFromUi = true;
      }
    });
  }

  private setupStormWeatherOverlay() {
    const wrap = document.createElement('div');
    wrap.id = 'storm-weather-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden;';
    const cvs = document.createElement('canvas');
    cvs.id = 'storm-rain-canvas';
    cvs.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    const flash = document.createElement('div');
    flash.id = 'storm-lightning-flash';
    flash.style.cssText = 'position:absolute;inset:0;background:#9fc4e6;opacity:0;mix-blend-mode:soft-light;';
    wrap.appendChild(cvs);
    wrap.appendChild(flash);
    const hud = document.getElementById('hud');
    if (hud?.parentNode) {
      hud.parentNode.insertBefore(wrap, hud);
    } else {
      document.body.appendChild(wrap);
    }
    this.stormRainCanvas = cvs;
    this.stormRainCtx = cvs.getContext('2d');
    this.stormLightningFlashEl = flash;
  }

  private setupStoryCutsceneOverlay() {
    const root = document.createElement('div');
    root.id = 'story-cutscene-overlay';
    root.style.cssText = [
      'position:fixed',
      'left:0',
      'right:0',
      'bottom:8vh',
      'z-index:76',
      'pointer-events:none',
      'display:flex',
      'justify-content:center',
      'opacity:0',
      'transform:translateY(14px)',
      'transition:opacity 420ms ease,transform 420ms ease',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'width:min(760px,calc(100vw - 42px))',
      'border-top:1px solid rgba(226,197,122,.6)',
      'border-bottom:1px solid rgba(226,197,122,.42)',
      'background:linear-gradient(90deg,rgba(7,10,16,0),rgba(8,11,17,.88) 13%,rgba(8,11,17,.9) 87%,rgba(7,10,16,0))',
      'padding:18px 34px 20px',
      'box-sizing:border-box',
      'text-align:center',
      'color:#f3e4bc',
      'text-shadow:0 2px 8px rgba(0,0,0,.75)',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font:700 18px Georgia,serif;letter-spacing:.04em;text-transform:uppercase;color:#f4cf7a;';
    const name = document.createElement('div');
    name.style.cssText = 'font:600 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#aebdd3;margin-top:5px;';
    const line = document.createElement('div');
    line.style.cssText = 'font:500 20px/1.38 Georgia,serif;margin-top:12px;color:#fff5d8;';
    const cue = document.createElement('div');
    cue.style.cssText = 'font:600 12px/1.3 system-ui,sans-serif;margin-top:10px;color:#d5bb79;';

    panel.appendChild(title);
    panel.appendChild(name);
    panel.appendChild(line);
    panel.appendChild(cue);
    root.appendChild(panel);
    document.body.appendChild(root);
    this.storyCutscene = { root, title, name, line, cue };
  }

  private computeStormWeatherIntensity(): number {
    if (!this.state) return 0;
    const player = this.getLocalPlayer();
    const dist = player
      ? this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ)
      : 0;
    if (!player) return 0;

    const safeRadius = Math.max(1, this.state.storm.safeRadius);
    const outside = dist > safeRadius;
    const phase = this.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);
    const phaseBoost = Math.min(1, phase / maxPhase) * 0.2;
    const shrinkBoost = this.state.storm.shrinking ? 0.08 + this.state.storm.shrinkProgress * 0.08 : 0;

    if (outside) {
      const stormDepth = THREE.MathUtils.clamp((dist - safeRadius) / 240, 0, 1);
      return Math.min(1, 0.52 + phaseBoost + shrinkBoost + stormDepth * 0.32);
    }

    const edgeFade = THREE.MathUtils.clamp((dist / safeRadius - 0.84) / 0.16, 0, 1);
    return Math.min(0.24, edgeFade * 0.14 + shrinkBoost * 0.45);
  }

  private computeStormRainIntensity(): number {
    if (!this.state) return 0;
    const player = this.getLocalPlayer();
    if (!player) return 0;

    const dist = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ);
    const safeRadius = Math.max(1, this.state.storm.safeRadius);
    if (dist <= safeRadius) return 0;

    const phase = this.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);
    const stormDepth = THREE.MathUtils.clamp((dist - safeRadius) / 220, 0, 1);
    const shrinkBoost = this.state.storm.shrinking ? 0.08 : 0;
    return Math.min(1, 0.34 + stormDepth * 0.42 + (phase / maxPhase) * 0.2 + shrinkBoost);
  }

  private updateStormRainOverlay(_dt: number, intensity: number) {
    const cv = this.stormRainCanvas;
    const ctx = this.stormRainCtx;
    if (!cv || !ctx) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rw = Math.floor(w * dpr);
    const rh = Math.floor(h * dpr);
    if (cv.width !== rw || cv.height !== rh) {
      cv.width = rw;
      cv.height = rh;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (intensity <= 0.001) return;
    const t = this.ocean.getTime();
    const drops = Math.floor(65 + intensity * 420);
    const alpha = 0.09 + intensity * 0.34;
    ctx.strokeStyle = `rgba(205, 222, 245, ${alpha})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < drops; i++) {
      const sx = (i * 173.17 + Math.sin(t * 0.31 + i) * 14) % w;
      const sy = ((i * 67.31 + t * (88 + intensity * 160)) % (h + 36)) - 18;
      const len = 6 + intensity * 26;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 1.35, sy + len);
      ctx.stroke();
    }
  }

  private updateStormLightningFlash(dt: number) {
    if (!this.stormLightningFlashEl) return;
    this.stormLightningFlashOpacity = Math.max(0, this.stormLightningFlashOpacity - dt * 4.8);
    this.stormLightningFlashEl.style.opacity = String(this.stormLightningFlashOpacity);
  }

  private updateLightning(dt: number) {
    if (!this.state) return;

    // Fade out any active flash
    if (this.lightningFlash) {
      this.lightningFlash.intensity -= dt * (18 + this.state.storm.phase * 4);
      if (this.lightningFlash.intensity <= 0) {
        this.renderer.scene.remove(this.lightningFlash);
        this.lightningFlash = null;
      }
    }

    const phase = this.state.storm.phase;
    const player = this.getLocalPlayer();
    const playerDist = player
      ? this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ)
      : 0;
    const outsideStorm = !!player
      && playerDist > this.state.storm.safeRadius;
    const nearStormWall = !!player && Math.abs(playerDist - this.state.storm.safeRadius) < 85;

    // Keep lightning tied to the storm front, not clear water well inside the safe zone.
    if (!outsideStorm && !(this.state.storm.shrinking && nearStormWall) && phase < 2) return;

    this.lightningTimer -= dt;
    if (this.lightningTimer <= 0) {
      const stormR = this.state.storm.safeRadius;
      const angle = Math.random() * Math.PI * 2;
      // Strike near the storm wall boundary
      const dist = stormR * (0.88 + Math.random() * 0.38);
      const lx = this.state.storm.centerX + Math.cos(angle) * dist;
      const lz = this.state.storm.centerZ + Math.sin(angle) * dist;

      const flash = new THREE.PointLight(
        0x9fc4e6,
        60 + phase * 10,
        Math.max(300, stormR * 0.9),
      );
      flash.position.set(lx, 85 + Math.random() * 50, lz);
      this.renderer.scene.add(flash);
      this.lightningFlash = flash;

      this.stormLightningFlashOpacity = Math.max(
        this.stormLightningFlashOpacity,
        0.18 + this.stormWeatherIntensity * 0.26 + phase * 0.015,
      );

      const baseCooldown = Math.max(
        0.75,
        10.5 - phase * 1.25 - (outsideStorm ? 3.2 : 0) - this.stormWeatherIntensity * 2.5,
      );
      this.lightningTimer = baseCooldown * (0.35 + Math.random() * 0.85);
    }
  }
}
