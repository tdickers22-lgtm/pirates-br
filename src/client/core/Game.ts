import * as THREE from 'three';
import { ECONOMY, PHYSICS, PLAYER, SHIP, SHIP_STATS, SHIP_UPGRADES, STORM_PHASES, WEAPONS, WORLD } from '../../shared/constants/index.js';
import type {
  GameState, HotSnapshotPayload, InteractIntent, Island, IslandNpc, IslandProp, IslandPropType, ItemStack, MatchStartPayload, Player, PlayerInput, Projectile, Ship, ShipKeg, ShipUpgradeType, TradeSession, TreasureChest, UpgradeStation, WeaponId, WeaponInstance, WildlifeAnimal, SeaRock,
} from '../../shared/types/index.js';
import { getBridgeDeckY, getSailRopeStationLocals, getIslandSurfacePoint, getIslandSurfaceY, getNearestShipBoardingLadder, getIslandDockSwimLadderPoint, isPointInsideIslandFootprint, sampleWind, angleWrap, getMainMastLocalZ, gerstnerHeight, WAVE_PARAMS, getStormWaveIntensity, getIslandMaxRadius, getCaveFloorY, getCaveCeilingY, isInsideSwimHullFootprint, pushOutOfSwimHullFootprint, getSwimHullVerticalBand, getIslandCoastWeights } from '../../shared/utils/index.js';
import { BIOME_PALETTES, getPropGroundY } from '../../shared/props.js';
import {
  findNearbyCannonIndex as findSharedNearbyCannonIndex,
  getAnchorControlLocal as getSharedAnchorControlLocal,
  getCannonDeckLocalPosition as getSharedCannonDeckLocalPosition,
  getSailControlLocal as getSharedSailControlLocal,
  isNearAnchor as isSharedNearAnchor,
  isNearCrowNestLadder as isSharedNearCrowNestLadder,
  isNearHelm as isSharedNearHelm,
  isNearSailStation as isSharedNearSailStation,
  toShipLocalPoint,
} from '../../shared/interactions.js';
import { Renderer } from '../rendering/Renderer.js';
import { OceanRenderer } from '../rendering/OceanRenderer.js';
import { ShipRenderer } from '../rendering/ShipRenderer.js';
import { CombatFx } from '../rendering/CombatFx.js';
import { SoundEngine } from '../audio/SoundEngine.js';
import { NetworkClient } from '../network/NetworkClient.js';
import { MenuController } from '../menu/MenuController.js';
import { InputManager } from '../input/InputManager.js';
import { assets, type AssetName } from '../assets/AssetLibrary.js';

const CLIENT_INPUT_SEND_INTERVAL = 1 / 45;
const CLIENT_INPUT_HEARTBEAT_INTERVAL = 0.2;
const CUTLASS_VIEW_CHARGE_TIME = 0.72;
const CUTLASS_VIEW_LUNGE_COOLDOWN = 1.05;

function installGeometryNaNGuard() {
  const proto = THREE.BufferGeometry.prototype as THREE.BufferGeometry & {
    __piratesBrNaNGuard?: boolean;
  };
  if (proto.__piratesBrNaNGuard) return;
  proto.__piratesBrNaNGuard = true;

  const originalComputeBoundingSphere = proto.computeBoundingSphere;
  proto.computeBoundingSphere = function guardedComputeBoundingSphere(this: THREE.BufferGeometry) {
    const position = this.getAttribute('position') as THREE.BufferAttribute | undefined;
    const values = position?.array as ArrayLike<number> & { [index: number]: number } | undefined;
    if (values) {
      let changed = false;
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) {
          values[i] = 0;
          changed = true;
        }
      }
      if (changed && position) position.needsUpdate = true;
    }
    return originalComputeBoundingSphere.call(this);
  };
}

installGeometryNaNGuard();

type ChestMeshRecord = {
  root: THREE.Group;
  glow: THREE.PointLight;
  /** Chest body — a GLB clone group, or the procedural box mesh fallback. */
  chestMesh: THREE.Object3D;
  /** Procedural lid (fallback only); a no-op placeholder group when the GLB body includes the lid. */
  lid: THREE.Object3D;
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

/**
 * A warm island light source (dock lantern, campfire, cave torch, tavern lantern).
 * The nearest few of each kind get a real PointLight at night; everything else
 * shows an additive glow sprite scaled by the night factor. `anchor` lives inside
 * its island group so it inherits the island transform and is disposed with it.
 */
type LanternEmitter = {
  anchor: THREE.Object3D;
  kind: 'lantern' | 'campfire';
  glow: THREE.Sprite;
  flame: THREE.Sprite | null;
  worldPos: THREE.Vector3;
  dist: number;
  phase: number;
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
  goldLeaders: HTMLDivElement;
  killCount: HTMLDivElement;
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
  shipStatus: HTMLDivElement;
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
  waterGauge: HTMLDivElement;
  waterGaugeFill: HTMLDivElement;
  waterGaugeTrend: HTMLSpanElement;
  waterGaugePct: HTMLSpanElement;
  barrelPanel: HTMLDivElement;
  barrelPanelLoot: HTMLDivElement;
  barrelPanelInventory: HTMLDivElement;
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
  brProgressFeed: HTMLDivElement;
};

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return element as T;
}

type PlayerTeamMaterials = {
  coatMat: THREE.MeshStandardMaterial;
  clothMat: THREE.MeshStandardMaterial;
  beltMat: THREE.MeshStandardMaterial;
  bandanaMat: THREE.MeshStandardMaterial;
};

function makeTeamShirtColor(color: number) {
  return new THREE.Color(color).lerp(new THREE.Color(0xf4ead8), 0.38);
}

function makeTeamBeltColor(color: number) {
  return new THREE.Color(color).lerp(new THREE.Color(0x2a1d14), 0.62);
}

function applyPlayerTeamColor(mesh: THREE.Group, color: number) {
  const userData = mesh.userData as {
    animation?: { variant?: 'pirate' | 'skeleton' };
    teamColor?: number;
    teamMaterials?: PlayerTeamMaterials;
  };
  if (userData.animation?.variant === 'skeleton' || userData.teamColor === color || !userData.teamMaterials) return;

  userData.teamMaterials.coatMat.color.set(color);
  userData.teamMaterials.clothMat.color.copy(makeTeamShirtColor(color));
  userData.teamMaterials.beltMat.color.copy(makeTeamBeltColor(color));
  userData.teamMaterials.bandanaMat.color.set(color);
  userData.teamColor = color;
}

function makePlayerMesh(
  color: number,
  variant: 'pirate' | 'skeleton' = 'pirate',
  role: 'captain' | 'crew' | 'raider' = 'crew',
): THREE.Group {
  const group = new THREE.Group();
  const isSkeleton = variant === 'skeleton';
  const isCaptain = role === 'captain';
  const teamShirtColor = makeTeamShirtColor(color);
  const teamBeltColor = makeTeamBeltColor(color);

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
  const clothMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xcfc8b8 : teamShirtColor, roughness: 0.96 });
  const skinMat = isSkeleton ? boneMat : pirateSkinMat;
  const darkMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xb5ac98 : 0x2a2019, roughness: 1 });
  const beltMat = new THREE.MeshStandardMaterial({ color: isSkeleton ? 0xc9c0ab : teamBeltColor, roughness: 1 });

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

  const bandanaMat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const bandana = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.04, 6, 18),
    bandanaMat,
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
  group.userData.teamColor = color;
  group.userData.teamMaterials = isSkeleton ? undefined : {
    coatMat,
    clothMat,
    beltMat,
    bandanaMat,
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

type PocketPreviewKind = 'banana' | 'wood' | 'coconut' | 'mango' | 'meat' | 'powder_keg' | 'shovel' | 'chest';

function makePocketPreviewMesh(kind: PocketPreviewKind): THREE.Group {
  const group = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf0c040, roughness: 0.42 });
  const husk = new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.88 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a4e28, roughness: 0.9 });
  const flesh = new THREE.MeshStandardMaterial({ color: 0xff9a30, roughness: 0.48 });
  const meatMat = new THREE.MeshStandardMaterial({ color: 0x7f2d1f, roughness: 0.74 });
  const searMat = new THREE.MeshStandardMaterial({ color: 0x2c1710, roughness: 0.92 });
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xe7d7b2, roughness: 0.8 });
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
  } else if (kind === 'meat') {
    const cut = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), meatMat);
    cut.scale.set(1.3, 0.72, 0.92);
    cut.rotation.z = -0.2;
    group.add(cut);

    const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.028, 0.26, 8), boneMat);
    bone.rotation.z = Math.PI * 0.5;
    bone.position.x = 0.13;
    group.add(bone);

    for (const x of [-0.03, 0.03]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.18), searMat);
      stripe.position.set(x, 0.066, 0);
      stripe.rotation.z = 0.5;
      group.add(stripe);
    }
  } else if (kind === 'chest') {
    const chestWood = new THREE.MeshStandardMaterial({ color: 0x6a3f1c, roughness: 0.78 });
    const chestTrim = new THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.36, metalness: 0.78, emissive: 0x3a2a06, emissiveIntensity: 0.34 });
    const lock = new THREE.MeshStandardMaterial({ color: 0x2d2218, roughness: 0.62, metalness: 0.62 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0x8f5f3c, roughness: 0.82 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.3), chestWood);
    body.position.y = -0.06;
    group.add(body);

    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.16, 0.3), chestWood);
    lid.position.set(0, 0.13, 0);
    lid.scale.y = 0.62;
    group.add(lid);

    const lidCap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.46, 18, 1, true, 0, Math.PI), chestWood);
    lidCap.rotation.z = Math.PI * 0.5;
    lidCap.position.set(0, 0.18, 0);
    group.add(lidCap);

    for (const dx of [-0.21, 0, 0.21]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.42, 0.31), chestTrim);
      band.position.set(dx, 0.04, 0);
      group.add(band);
    }
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.025, 0.31), chestTrim);
    rim.position.set(0, 0.06, 0);
    group.add(rim);

    const lockMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.025), lock);
    lockMesh.position.set(0, 0.05, 0.16);
    group.add(lockMesh);

    const glow = new THREE.PointLight(0xffd278, 0.55, 1.4, 1.5);
    glow.position.set(0, 0.06, 0.2);
    group.add(glow);

    // Forearms gripping the chest from below — sells the carry pose in first-person.
    for (const side of [-1, 1]) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), skinMat);
      hand.position.set(side * 0.22, -0.18, 0.18);
      hand.scale.set(1.1, 0.85, 1.0);
      group.add(hand);
    }
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
  if (projectile.type === 'tsunami') {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(46, 3.4, 6),
      new THREE.MeshBasicMaterial({
        color: 0x7fe7ff,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.castShadow = false;
    return mesh;
  }

  if (projectile.type === 'chainshot') {
    // Spinning ball-and-chain: two iron balls joined by a short chain, whirled in
    // flight (see syncProjectiles). Parent mesh is one ball; the other + chain are
    // children so the whole assembly tumbles as a unit.
    const ballGeo = new THREE.SphereGeometry(0.14, 10, 8);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.5, metalness: 0.75 });
    const mesh = new THREE.Mesh(ballGeo, ballMat);
    mesh.castShadow = true;
    const ballB = new THREE.Mesh(ballGeo, ballMat);
    ballB.position.set(0, 0, 0.42);
    ballB.castShadow = true;
    mesh.add(ballB);
    const chain = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.42)]),
      new THREE.LineBasicMaterial({ color: 0x1c2024 }),
    );
    mesh.add(chain);
    mesh.userData.chainshot = true;
    return mesh;
  }

  const superShot = projectile.special === 'super_cannonball';
  const colorByType: Record<Projectile['type'], number> = {
    bullet: 0xf7e7a9,
    cannonball: superShot ? 0xffd15c : 0x2e2e2e,
    firebomb: 0xff6b2d,
    chainshot: 0x91b7c8,
    tsunami: 0x7fe7ff,
  };

  const radius = projectile.type === 'bullet' ? 0.08 : superShot ? 0.42 : 0.26;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 12),
    new THREE.MeshStandardMaterial({
      color: colorByType[projectile.type],
      emissive: projectile.type === 'firebomb' ? 0xaa3300 : superShot ? 0x8f4d00 : 0x000000,
      emissiveIntensity: projectile.type === 'firebomb' ? 1.2 : superShot ? 0.9 : 0,
      roughness: projectile.type === 'cannonball' ? 0.82 : 0.45,
      metalness: projectile.type === 'cannonball' ? 0.34 : 0,
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

/** Soft warm radial halo for island lantern / campfire glow sprites. */
function makeLanternGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,240,200,0.95)');
    grad.addColorStop(0.32, 'rgba(255,196,116,0.52)');
    grad.addColorStop(0.7, 'rgba(255,150,72,0.14)');
    grad.addColorStop(1, 'rgba(255,140,64,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Teardrop flame billboard for campfire flame sprites (bright base, wispy tip). */
function makeLanternFlameTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 74, 2, 32, 62, 46);
    grad.addColorStop(0, 'rgba(255,248,214,0.98)');
    grad.addColorStop(0.35, 'rgba(255,190,96,0.85)');
    grad.addColorStop(0.7, 'rgba(255,120,44,0.34)');
    grad.addColorStop(1, 'rgba(200,64,20,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(32, 4);
    ctx.quadraticCurveTo(60, 52, 48, 82);
    ctx.quadraticCurveTo(32, 100, 16, 82);
    ctx.quadraticCurveTo(4, 52, 32, 4);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ── Foliage alpha textures (cached; white shapes so per-instance colors tint
// them). These turn the flat cross-quads from solid green rectangles into
// wispy grass blades / feathered fern fronds. ──
let _grassBladeTex: THREE.CanvasTexture | null = null;
let _fernFrondTex: THREE.CanvasTexture | null = null;

function makeGrassBladeTexture(): THREE.CanvasTexture {
  if (_grassBladeTex) return _grassBladeTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  // A tuft of tapering blades fanning up from the bottom edge. White with a
  // slight top-fade so tips feel soft; alpha carries the blade shape.
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const baseX = size * (0.12 + (i / (blades - 1)) * 0.76);
    const lean = (i - (blades - 1) / 2) * 6 + (Math.sin(i * 2.3) * 5);
    const tipX = baseX + lean;
    const w = 6 + (i % 3) * 2;
    const tipY = size * (0.06 + (i % 4) * 0.05);
    const grad = ctx.createLinearGradient(0, size, 0, tipY);
    grad.addColorStop(0, 'rgba(230,255,220,0.95)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.98)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseX - w * 0.5, size);
    ctx.quadraticCurveTo((baseX + tipX) * 0.5 - w * 0.3, size * 0.5, tipX, tipY);
    ctx.quadraticCurveTo((baseX + tipX) * 0.5 + w * 0.3, size * 0.5, baseX + w * 0.5, size);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _grassBladeTex = tex;
  return tex;
}

function makeFernFrondTexture(): THREE.CanvasTexture {
  if (_fernFrondTex) return _fernFrondTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  // A single arching frond: central rachis + paired pinnae (leaflets).
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineCap = 'round';
  const baseX = size * 0.5;
  const tipX = size * 0.66;
  const rachis = (t: number) => ({
    x: baseX + (tipX - baseX) * t,
    y: size - (size * 0.92) * t,
  });
  // rachis
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(baseX, size);
  for (let t = 0; t <= 1; t += 0.1) { const p = rachis(t); ctx.lineTo(p.x, p.y); }
  ctx.stroke();
  // pinnae
  ctx.lineWidth = 3;
  for (let t = 0.08; t < 0.98; t += 0.075) {
    const p = rachis(t);
    const len = (1 - t) * size * 0.32 + 6;
    const droop = 0.5 + t * 0.5;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(p.x + side * len * 0.6, p.y + len * 0.15 * droop, p.x + side * len, p.y + len * 0.35 * droop);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _fernFrondTex = tex;
  return tex;
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
  // Weathered WOOD plank, not a near-black board — reads as a carved sign from
  // a distance against bright terrain instead of a black slab.
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, 'rgba(158, 118, 66, 0.99)');
  gradient.addColorStop(0.5, 'rgba(139, 101, 54, 0.99)');
  gradient.addColorStop(1, 'rgba(122, 87, 46, 0.99)');
  ctx.fillStyle = gradient;
  ctx.fillRect(12, 12, canvas.width - 24, canvas.height - 24);
  // Plank grain streaks
  ctx.strokeStyle = 'rgba(90, 62, 32, 0.35)';
  ctx.lineWidth = 2;
  for (let gy = 30; gy < canvas.height - 20; gy += 22) {
    ctx.beginPath();
    ctx.moveTo(16, gy + Math.sin(gy) * 3);
    ctx.lineTo(canvas.width - 16, gy + Math.cos(gy * 0.7) * 3);
    ctx.stroke();
  }
  ctx.lineWidth = 8;
  ctx.strokeStyle = accent;
  ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(58, 38, 18, 0.7)';
  ctx.strokeRect(34, 34, canvas.width - 68, canvas.height - 68);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Dark engraved lettering on the light plank
  ctx.fillStyle = '#2c1a0a';
  ctx.font = '700 46px Georgia, serif';
  ctx.fillText(title.toUpperCase(), canvas.width * 0.5, 72);
  ctx.fillStyle = accent;
  ctx.font = '700 28px system-ui, sans-serif';
  ctx.fillText(effect, canvas.width * 0.5, 122);
  ctx.fillStyle = 'rgba(52, 34, 16, 0.82)';
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

/**
 * Stylized mermaid: glowing aqua humanoid torso + tail. Placed in the water near
 * a swimming player to mark their "Press X to return to ship" target.
 */
function buildMermaidMesh(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'mermaid';

  // Soft glow halo so she's visible at distance
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0x86e8ff,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );
  halo.position.y = 0.6;
  group.add(halo);

  // Torso
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.7, 6, 12),
    new THREE.MeshStandardMaterial({
      color: 0xfdd9b8,
      emissive: 0x86e8ff,
      emissiveIntensity: 0.45,
      roughness: 0.55,
      metalness: 0.05,
    }),
  );
  torso.position.y = 1.05;
  group.add(torso);

  // Head
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffe6cc,
      roughness: 0.5,
      metalness: 0.05,
    }),
  );
  head.position.y = 1.55;
  group.add(head);

  // Hair (dark teal flowing back)
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6),
    new THREE.MeshStandardMaterial({ color: 0x153a4a, roughness: 0.7 }),
  );
  hair.position.set(0, 1.6, -0.05);
  group.add(hair);

  // Tail (longer cone, scales)
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x2cd0bf,
    emissive: 0x47e8d6,
    emissiveIntensity: 0.55,
    roughness: 0.35,
    metalness: 0.4,
  });
  const tailUpper = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.18, 0.8, 12), tailMat);
  tailUpper.position.y = 0.35;
  group.add(tailUpper);
  const tailLower = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.07, 0.6, 12), tailMat);
  tailLower.position.y = -0.18;
  group.add(tailLower);

  // Tail fin (a flat fan)
  const finGeom = new THREE.ConeGeometry(0.55, 0.55, 8, 1, true);
  const fin = new THREE.Mesh(finGeom, tailMat);
  fin.rotation.x = Math.PI;
  fin.scale.set(1.0, 0.18, 1.0);
  fin.position.set(0, -0.5, 0);
  group.add(fin);

  // Arm hints (just blobs)
  const armMat = new THREE.MeshStandardMaterial({
    color: 0xfdd9b8,
    emissive: 0x86e8ff,
    emissiveIntensity: 0.3,
    roughness: 0.55,
  });
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.55, 4, 8), armMat);
    arm.position.set(0.34 * sx, 1.05, 0);
    arm.rotation.z = (Math.PI / 6) * sx;
    group.add(arm);
  }

  group.userData.bobPhase = Math.random() * Math.PI * 2;
  return group;
}

export class Game {
  private readonly renderer = new Renderer();
  private readonly ocean = new OceanRenderer();
  /** EMA-smoothed offset mapping performance.now()/1000 onto server sim seconds. */
  private serverTimeOffset: number | null = null;
  private readonly shipRenderer = new ShipRenderer();
  private readonly combatFx = new CombatFx();
  private readonly audio = new SoundEngine();
  // Edge-detect state for sound triggers (chest carry, drowning, eating, sail/anchor changes).
  private prevCarryingChestId: string | null = null;
  private prevPlayerStateForAudio: string | null = null;
  private prevPocketUseCooldown = 0;
  private prevAnchored: boolean | null = null;
  private prevAnchorRaiseProgress: number | null = null;
  private prevSailHeightForAudio: number | null = null;
  private prevSailAngleForAudio: number | null = null;
  private lastSailTrimSoundAt = 0;
  private lastAnchorMoveSoundAt = 0;
  private lastHelmTurnSoundAt = 0;
  private lastHullSplashAt = 0;
  private lastSwimSplashAt = 0;
  private prevStormPhase = -1;
  private digStrikePhase = 0;
  private prevMeleeReloading = false;
  private prevCannonBallistic = false;
  private prevStormShrinking = false;
  // Bilge flooding audio loop + FX throttles (naval damage loop).
  private floodingLoopActive = false;
  private lastBailFxAt = 0;
  private lastHullLeakAt = 0;
  private readonly lastChainshotWhirrAt = new Map<string, number>();
  // Camera feel — additive on top of updateCamera's base FOV/orientation.
  private cameraFovKick = 0;      // eased FOV bump in degrees
  private cameraShake = 0;        // trauma 0..1, decays each frame
  private cameraShakeCannon = 0;  // brief own-cannon FOV pop 0..1
  private cameraRoll = 0;         // smoothed deck-roll coupling (rad)
  private prevOwnHullTotal = 4;   // sum of local ship hull sections for hit detection
  private prevOwnShipId: string | null = null;
  private readonly tempShakeVec = new THREE.Vector3();
  // Island lantern / campfire warm-light budget.
  private readonly lanternRoot = new THREE.Group();
  private readonly lanternLightPool: THREE.PointLight[] = [];
  private readonly campfireLightPool: THREE.PointLight[] = [];
  private readonly lanternEmitters: LanternEmitter[] = [];
  private readonly assignedLanterns: LanternEmitter[] = [];
  private readonly assignedCampfires: LanternEmitter[] = [];
  private lanternGlowTexture: THREE.Texture | null = null;
  private lanternFlameTexture: THREE.Texture | null = null;
  /** Currently-browsed barrel — renders the side-by-side inventory comparison panel */
  private barrelBrowse: { barrelId: string; loot: ItemStack[]; lastEventAt: number } | null = null;
  private readonly network = new NetworkClient();
  private readonly input = new InputManager();
  private readonly menu = new MenuController({
    network: this.network,
    audio: this.audio,
    input: this.input,
    onMatchStart: (payload) => this.onMatchStartFromMenu(payload),
    onReturnToMenu: () => this.onReturnToMenuFromEnd(),
  });
  // Used by ambient render & end-of-round flow.
  // @ts-expect-error reserved for future ambient-vs-in-match branching
  private inMatch = false;
  // @ts-expect-error reserved for showing the leaderboard until user dismisses it
  private endmatchPending = false;
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
    goldLeaders: requireElement('gold-leaders'),
    killCount: requireElement('kill-count'),
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
    shipStatus: requireElement('ship-status'),
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
    waterGauge: requireElement('water-gauge'),
    waterGaugeFill: requireElement('wg-fill'),
    waterGaugeTrend: requireElement('wg-trend'),
    waterGaugePct: requireElement('wg-pct'),
    barrelPanel: requireElement('barrel-panel'),
    barrelPanelLoot: requireElement('barrel-panel-loot'),
    barrelPanelInventory: requireElement('barrel-panel-inventory'),
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
    brProgressFeed: requireElement('br-progress-feed'),
  };

  private state: GameState | null = null;
  private playersById = new Map<string, Player>();
  private shipsById = new Map<string, Ship>();
  private livePlayerIds = new Set<string>();
  private liveProjectileIds = new Set<string>();
  private liveKegIds = new Set<string>();
  private localPlayerId: string | null = null;
  private localShipId: string | null = null;
  /** Cleared when the server sends `join`; avoids an endless 68% bar if assignment stalls. */
  private joinAssignmentWatchdog: number | null = null;
  private lastFrameTime = performance.now();
  private frameDt = 1 / 60;
  private readonly debugPerfEnabled = (() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('debug') || params.has('perf');
  })();
  /** ?stormdemo — client-visual storm preview (raging seas, rain, tint) without
   *  waiting for real storm phases. Screenshot/dev aid; server sim unaffected. */
  private readonly debugStormDemo = new URLSearchParams(window.location.search).has('stormdemo');
  /** F8 = one-keypress bug report: next frame is captured (canvas + state)
   *  and POSTed to /bugsnap on the game server → data/bugsnaps/. */
  private bugSnapRequested = false;
  private bugSnapListenerBound = false;
  private readonly bugSnapListener = (event: KeyboardEvent) => {
    if (event.code === 'F8') {
      event.preventDefault();
      this.bugSnapRequested = true;
    }
  };
  private debugPerfPanel: HTMLDivElement | null = null;
  private debugFrameCounter = 0;
  private debugFrameAccum = 0;
  private debugFps = 0;
  private debugWorstFrameMs = 0;
  private debugRawFrameMs = 16.7;
  private debugUpdateTimer = 0;
  private hudTimer = 0;
  private minimapTimer = 0;
  private interactScanTimer = 0;
  private slowSceneTimer = 0;
  private inputSendTimer = 0;
  private inputHeartbeatTimer = 0;
  private windWispTimer = 0;
  private rainOverlayTimer = 0;
  private lastSentInputSignature = '';
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
  private lightningLightPool: THREE.PointLight | null = null;
  private lightningBolt: THREE.Line | null = null;
  private spyglassActive = false;
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
  private readonly tempKegPos = new THREE.Vector3();
  private readonly tempSharkPos = new THREE.Vector3();
  private readonly tempWildlifePos = new THREE.Vector3();
  private readonly tempHudVector = new THREE.Vector3();
  private readonly tempRenderPos = new THREE.Vector3();
  private readonly tempBallisticPos = new THREE.Vector3();
  private readonly localViewWeaponRoot = new THREE.Group();
  /** First-person hands shown while cranking the capstan (anchor hold). */
  private readonly localViewHandsRoot = new THREE.Group();
  private capstanHandsBuilt = false;
  private readonly localViewPocketRoot = new THREE.Group();
  private localViewPocketKind: PocketPreviewKind | null = null;
  private pocketUsePreviewKind: PocketPreviewKind | null = null;
  private pocketUsePreviewTimer = 0;
  private treasureChartSignature = '';
  private pocketStripSignature = '';
  private shipUpgradeSignature = '';
  private shipInventorySignature = '';
  private brProgressSignature = '';
  private localViewWeaponId: WeaponInstance['weaponId'] | null = null;
  private localViewWeaponKick = 0;
  /** First-person muzzle flash + powder smoke on the local viewmodel barrel. */
  private muzzleFlash: THREE.Sprite | null = null;
  private muzzleGlow: THREE.PointLight | null = null;
  private muzzleSmoke: THREE.Sprite[] = [];
  private muzzleFlashTimer = 0;
  private prevLocalFiring = false;
  private localViewWeaponReloadPhase = 0;
  private localCutlassCharge = 0;
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
  private readonly wildlifeMeshes = new Map<string, THREE.Group>();
  private readonly seaRockMeshes = new Map<string, THREE.Group>();
  private readonly kegMeshes = new Map<string, KegMeshRecord>();
  private readonly upgradeStationMeshes = new Map<string, UpgradeStationMeshRecord>();
  private readonly npcMeshes = new Map<string, NpcMeshRecord>();
  private readonly playerMeshes = new Map<string, THREE.Group>();
  private readonly projectileMeshes = new Map<string, THREE.Mesh>();
  private readonly windWispMeshes: WindWispRecord[] = [];
  private readonly seenStoryNpcIds = new Set<string>();

  private readonly environment = new THREE.Group();
  private readonly windWisps = new THREE.Group();
  private readonly mermaidGroup = buildMermaidMesh();
  private mermaidAnchor: { x: number; z: number; shipId: string } | null = null;
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
    document.addEventListener('contextmenu', (event) => event.preventDefault());

    this.setLoading(4, 'Hoisting sails...');
    await this.yieldForLoadingPaint();

    this.renderer.init();
    this.setupDebugPerfPanel();
    this.setLoading(8, 'Charting the horizon...');
    await this.yieldForLoadingPaint();

    // Real progress: the GLB prop library is the bulk of boot time. Failures are
    // tolerated inside preload() — missing assets keep their procedural fallbacks.
    await assets.preload((done, total) => {
      this.setLoading(8 + (done / total) * 44, `Loading ship's stores... ${done}/${total}`);
    });
    await this.yieldForLoadingPaint();

    this.setupStormWeatherOverlay();
    this.setupStoryCutsceneOverlay();
    this.bindInteractPromptClick();
    this.localViewWeaponRoot.visible = false;
    this.localViewWeaponRoot.renderOrder = 999;
    this.renderer.camera.add(this.localViewWeaponRoot);
    this.setupMuzzleFlash();
    this.localViewHandsRoot.visible = false;
    this.renderer.camera.add(this.localViewHandsRoot);
    this.localViewPocketRoot.visible = false;
    this.localViewPocketRoot.renderOrder = 999;
    this.renderer.camera.add(this.localViewPocketRoot);
    this.ocean.init(this.renderer.scene, this.renderer.getQuality());
    this.setLoading(56, 'Stirring the deep...');
    await this.yieldForLoadingPaint();

    this.shipRenderer.init(this.renderer.scene, this.renderer.getQuality());
    this.setLoading(62, 'Rigging the brigantine...');
    await this.yieldForLoadingPaint();

    this.combatFx.init(this.renderer.scene);
    this.initLanternSystem();
    this.renderer.scene.add(this.environment);
    this.renderer.scene.add(this.windWisps);
    this.renderer.scene.add(this.mermaidGroup);
    this.mermaidGroup.visible = false;
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
    this.setLoading(68, 'Reading the weather glass...');
    await this.yieldForLoadingPaint();

    this.input.init(this.renderer.renderer.domElement);
    this.bindSupplyWheelActions();
    document.body.addEventListener('pointerdown', () => {
      this.combatFx.unlockAudio();
      this.audio.unlock();
    });
    document.body.addEventListener('keydown', () => {
      this.combatFx.unlockAudio();
      this.audio.unlock();
    });
    // Universal UI feedback — anything that's a <button> chirps on click.
    document.body.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, [data-ui-click]')) {
        this.audio.playUiClick();
      }
    }, true);
    this.bindMapUiActions();
    this.bindTradeUiActions();
    this.bindNetworkEvents();

    this.showLoadingScreen('Opening crew waters...', 74);
    await this.yieldForLoadingPaint();
    this.menu.init();
    const connected = await this.connectToServer();
    if (!connected) return;
    // Hide loading, show main menu — the game frame loop still runs for ambient render later.
    this.ui.loadingScreen.classList.add('hidden');
    this.ui.loadingScreen.style.display = 'none';
    this.menu.show();

    requestAnimationFrame((time) => this.frame(time));
  }

  private async connectToServer(): Promise<boolean> {
    const socketUrl = this.getSocketUrl();
    this.setLoading(80, `Connecting to ${socketUrl} ...`);
    await this.yieldForLoadingPaint();
    const connectTimeoutMs = 6_000;
    try {
      await Promise.race([
        this.network.connect(socketUrl),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('connect-timeout')), connectTimeoutMs);
        }),
      ]);
    } catch {
      this.network.disconnect();
      this.setLoading(
        0,
        `Cannot reach game server at ${socketUrl}. Make sure 'npm run dev' is running (server on :8080), then refresh.`,
      );
      return false;
    }
    return true;
  }

  private onMatchStartFromMenu(payload?: MatchStartPayload): void {
    this.resetLocalRoundState();
    this.inMatch = true;
    this.endmatchPending = false;
    this.menu.setLastMatchPartyCode(payload?.partyCode ?? null);
    this.scheduleJoinAssignmentWatchdog();
    this.bindReturnToMenuButtons();
    this.audio.unlock();
    this.audio.playMatchStart();
  }

  private returnToMenuButtonsBound = false;
  private pointerLockHintEl: HTMLElement | null = null;
  private bindReturnToMenuButtons(): void {
    if (this.returnToMenuButtonsBound) return;
    this.returnToMenuButtonsBound = true;
    const handler = () => this.goBackToMenuFromMatch();
    document.getElementById('death-return-btn')?.addEventListener('click', handler);
    document.getElementById('win-return-btn')?.addEventListener('click', handler);
  }

  private onReturnToMenuFromEnd(): void {
    this.inMatch = false;
    this.endmatchPending = false;
    this.ui.deathScreen.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    this.ui.winScreen.classList.remove('visible');
    this.ui.winScreen.style.display = 'none';
    document.getElementById('hud')?.classList.remove('visible');
    this.resetLocalRoundState();
  }

  private showLoadingScreen(message: string, percent: number) {
    this.ui.loadingScreen.style.display = 'flex';
    this.ui.loadingScreen.style.opacity = '1';
    this.ui.loadingScreen.style.pointerEvents = 'auto';
    this.setLoading(percent, message);
  }

  private scheduleJoinAssignmentWatchdog() {
    this.clearJoinAssignmentWatchdog();
    this.joinAssignmentWatchdog = window.setTimeout(() => {
      this.joinAssignmentWatchdog = null;
      if (this.localPlayerId != null) return;
      this.setLoading(
        0,
        'Connected but no ship assignment yet. Check the server log or refresh.',
      );
    }, 45_000);
  }

  private clearJoinAssignmentWatchdog() {
    if (this.joinAssignmentWatchdog != null) {
      window.clearTimeout(this.joinAssignmentWatchdog);
      this.joinAssignmentWatchdog = null;
    }
  }

  /** Lets the browser paint `setLoading` before the next long synchronous chunk (main-thread init was freezing the bar). */
  private yieldForLoadingPaint(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  private resetLocalRoundState() {
    this.clearJoinAssignmentWatchdog();
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
    this.inputSendTimer = 0;
    this.inputHeartbeatTimer = 0;
    this.lastSentInputSignature = '';
    this.prevAnchored = null;
    this.prevAnchorRaiseProgress = null;
    this.prevSailHeightForAudio = null;
    this.prevSailAngleForAudio = null;
    this.lastSailTrimSoundAt = 0;
    this.lastAnchorMoveSoundAt = 0;
    this.lastHelmTurnSoundAt = 0;
    this.lastHullSplashAt = 0;
    this.lastSwimSplashAt = 0;
    this.prevPlayerStateForAudio = null;
    this.prevCannonBallistic = false;
    this.prevStormShrinking = false;
    this.lastBailFxAt = 0;
    this.lastHullLeakAt = 0;
    this.lastChainshotWhirrAt.clear();
    this.cameraFovKick = 0;
    this.cameraShake = 0;
    this.cameraShakeCannon = 0;
    this.cameraRoll = 0;
    this.prevOwnHullTotal = 4;
    this.prevOwnShipId = null;
    if (this.floodingLoopActive) {
      this.audio.stopFlooding();
      this.floodingLoopActive = false;
    }
    this.ui.waterGauge.classList.remove('visible', 'danger');

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
    this.disposeSceneObject(this.localViewWeaponRoot);
    this.localViewWeaponRoot.clear();
    this.localViewPocketRoot.visible = false;
    this.disposeSceneObject(this.localViewPocketRoot);
    this.localViewPocketRoot.clear();

    for (const indicator of this.floatingDamageIndicators) {
      indicator.element.remove();
    }
    this.floatingDamageIndicators.length = 0;

    for (const mesh of this.playerMeshes.values()) {
      this.renderer.scene.remove(mesh);
      this.disposeSceneObject(mesh);
    }
    for (const mesh of this.projectileMeshes.values()) {
      this.renderer.scene.remove(mesh);
      this.disposeSceneObject(mesh);
    }
    for (const record of this.kegMeshes.values()) {
      this.renderer.scene.remove(record.root);
      this.disposeSceneObject(record.root);
    }

    // Free GPU resources from the previous match (geometries/materials/textures).
    // AssetLibrary-owned shared resources are skipped inside disposeSceneObject.
    for (const child of [...this.environment.children]) {
      this.disposeSceneObject(child);
    }
    this.environment.clear();
    this.clearLanternEmitters();
    this.shipRenderer.clear();
    this.islandMeshes.clear();
    this.chestMeshes.clear();
    this.barrelMeshes.clear();
    this.sharkMeshes.clear();
    this.wildlifeMeshes.clear();
    this.seaRockMeshes.clear();
    this.kegMeshes.clear();
    this.upgradeStationMeshes.clear();
    this.npcMeshes.clear();
    this.playerMeshes.clear();
    this.projectileMeshes.clear();
    this.seenStoryNpcIds.clear();
  }

  /**
   * Recursively dispose GPU resources (geometry, materials, textures) of a
   * per-match scene graph. Resources owned by the shared AssetLibrary cache
   * (GLB clones/instances) are skipped — they outlive matches by design.
   */
  private disposeSceneObject(root: THREE.Object3D) {
    root.traverse((obj) => {
      const light = obj as THREE.Light;
      if (light.isLight) {
        light.dispose();
        return;
      }
      const mesh = obj as THREE.Mesh;
      const drawable = mesh as unknown as { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
      if (!drawable.isMesh && !drawable.isLine && !drawable.isPoints && !drawable.isSprite) return;
      const instanced = obj as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) instanced.dispose();
      if (mesh.geometry && !assets.isShared(mesh.geometry)) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        if (assets.isShared(material)) continue;
        const record = material as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          const value = record[key] as { isTexture?: boolean; dispose?: () => void } | null;
          if (value && value.isTexture && typeof value.dispose === 'function' && !assets.isShared(value)) {
            value.dispose();
          }
        }
        material.dispose();
      }
    });
  }

  /**
   * Clone a GLB library prop and place it. Returns null when the asset failed
   * to load (callers keep their procedural fallback). Kept signature-stable so
   * a later server-driven prop registry can reuse it.
   */
  private buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale = 1): THREE.Group | null {
    const clone = assets.clone(type);
    if (!clone) return null;
    clone.position.copy(position);
    clone.rotation.y = yaw;
    clone.scale.setScalar(scale);
    return clone;
  }

  /** Render the SERVER's deterministic prop registry (island.props) — the same
   *  registry PhysicsSystem collides against every tick. Before this, the
   *  client scattered its own decorative palms/boulders while the real
   *  colliders stayed invisible: players got shoved by nothing and walked
   *  through every visible tree. Rendering the registry makes visuals ==
   *  colliders, and finally shows the roster landmarks (watchtowers, standing
   *  stones, wrecks) that were generated but never drawn. */
  private buildServerProps(island: Island, group: THREE.Group, lowDetail: boolean) {
    const props = island.props ?? [];
    if (props.length === 0) return;
    const instancedTypes: ReadonlySet<string> = new Set([
      'palm_a', 'palm_b', 'palm_c', 'boulder_a', 'boulder_b', 'boulder_c', 'barrel', 'crate',
      'bush', 'bush_berry', 'flower_bush', 'fern_plant',
    ]);
    const buckets = new Map<IslandPropType, IslandProp[]>();
    for (const prop of props) {
      // Dock modules are collider-only entries; the dock is drawn from island.dock.
      if (prop.type === 'dock_mid' || prop.type === 'dock_end') continue;
      const list = buckets.get(prop.type);
      if (list) list.push(prop);
      else buckets.set(prop.type, [prop]);
    }
    const mat4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scl = new THREE.Vector3();
    for (const [type, list] of buckets) {
      const merged = instancedTypes.has(type) ? assets.mergedGeometry(type as AssetName) : null;
      if (merged) {
        const inst = new THREE.InstancedMesh(merged.geometry, merged.material, list.length);
        list.forEach((prop, i) => {
          pos.set(prop.x - island.position.x, getPropGroundY(island, prop), prop.z - island.position.z);
          euler.set(0, prop.yaw, 0);
          quat.setFromEuler(euler);
          scl.setScalar(prop.scale);
          mat4.compose(pos, quat, scl);
          inst.setMatrixAt(i, mat4);
        });
        inst.castShadow = !lowDetail;
        inst.receiveShadow = true;
        inst.instanceMatrix.needsUpdate = true;
        group.add(inst);
        continue;
      }
      for (const prop of list) {
        const localPos = new THREE.Vector3(
          prop.x - island.position.x,
          getPropGroundY(island, prop),
          prop.z - island.position.z,
        );
        const node = this.buildPropInstance(prop.type as AssetName, localPos, prop.yaw, prop.scale);
        if (!node) continue;
        node.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = !lowDetail;
            obj.receiveShadow = true;
          }
        });
        group.add(node);
        if (prop.type === 'campfire') {
          this.registerLanternEmitter(group, localPos.x, localPos.y + 0.4, localPos.z, 'campfire');
        } else if (prop.type === 'lantern_post') {
          this.registerLanternEmitter(group, localPos.x, localPos.y + 2.1, localPos.z, 'lantern');
        }
      }
    }
  }

  // ── Island lantern / campfire warm-light budget ──────────────────────────
  // Shared point-light pools (added once, reused across matches) plus per-emitter
  // additive glow / flame sprites. The nearest N of each kind are lit for real at
  // night; everything else is a cheap sprite. See updateLanterns().
  private initLanternSystem() {
    this.lanternGlowTexture = makeLanternGlowTexture();
    this.lanternFlameTexture = makeLanternFlameTexture();
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffb257, 0, 17, 1.6);
      light.visible = false;
      this.lanternRoot.add(light);
      this.lanternLightPool.push(light);
    }
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xff7a30, 0, 15, 1.5);
      light.visible = false;
      this.lanternRoot.add(light);
      this.campfireLightPool.push(light);
    }
    this.renderer.scene.add(this.lanternRoot);
  }

  /** Register a warm island light. `container` is an island sub-group (dock/camp/
   *  tavern/cave); the anchor tracks its transform so world positions stay correct. */
  private registerLanternEmitter(
    container: THREE.Object3D,
    localX: number,
    localY: number,
    localZ: number,
    kind: 'lantern' | 'campfire',
  ) {
    if (!this.lanternGlowTexture) return;
    const anchor = new THREE.Object3D();
    anchor.position.set(localX, localY, localZ);
    container.add(anchor);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.lanternGlowTexture,
      color: kind === 'campfire' ? 0xff8a3c : 0xffbb66,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    }));
    glow.scale.setScalar(kind === 'campfire' ? 3.4 : 2.1);
    glow.visible = false;
    this.lanternRoot.add(glow);

    let flame: THREE.Sprite | null = null;
    if (kind === 'campfire' && this.lanternFlameTexture) {
      flame = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.lanternFlameTexture,
        color: 0xffb257,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      }));
      flame.center.set(0.5, 0.08); // pivot near the base so it grows upward
      flame.scale.set(0.5, 0.9, 1);
      this.lanternRoot.add(flame);
    }

    this.lanternEmitters.push({
      anchor, kind, glow, flame,
      worldPos: new THREE.Vector3(),
      dist: 0,
      phase: Math.random() * Math.PI * 2,
    });
  }

  private updateLanterns(nf: number, cameraPos: THREE.Vector3, t: number) {
    if (this.lanternEmitters.length === 0) return;
    const day = nf <= 0.02;

    for (const e of this.lanternEmitters) {
      e.anchor.getWorldPosition(e.worldPos);
      e.dist = e.worldPos.distanceTo(cameraPos);
    }

    const lanterns = this.lanternEmitters.filter((e) => e.kind === 'lantern');
    const campfires = this.lanternEmitters.filter((e) => e.kind === 'campfire');
    this.assignLanternBudget(lanterns, this.assignedLanterns, this.lanternLightPool.length);
    this.assignLanternBudget(campfires, this.assignedCampfires, this.campfireLightPool.length);

    for (let i = 0; i < this.lanternLightPool.length; i++) {
      const light = this.lanternLightPool[i];
      const e = this.assignedLanterns[i];
      if (day || !e) {
        light.visible = false;
        light.intensity = 0;
      } else {
        const flicker = 1 + Math.sin(t * 7.3 + e.phase) * 0.05 + Math.sin(t * 13.7 + e.phase * 1.7) * 0.03;
        light.position.copy(e.worldPos);
        light.intensity = nf * 1.55 * flicker;
        light.visible = true;
      }
    }
    for (let i = 0; i < this.campfireLightPool.length; i++) {
      const light = this.campfireLightPool[i];
      const e = this.assignedCampfires[i];
      if (day || !e) {
        light.visible = false;
        light.intensity = 0;
      } else {
        const flicker = 1 + Math.sin(t * 11 + e.phase) * 0.24 + Math.sin(t * 23 + e.phase * 2.1) * 0.14 + (Math.random() - 0.5) * 0.08;
        light.position.copy(e.worldPos);
        light.intensity = nf * 1.9 * Math.max(0.25, flicker);
        light.visible = true;
      }
    }

    for (const e of this.lanternEmitters) {
      const hasRealLight = e.kind === 'lantern'
        ? this.assignedLanterns.includes(e)
        : this.assignedCampfires.includes(e);
      const glowFlicker = e.kind === 'campfire'
        ? 1 + Math.sin(t * 12 + e.phase) * 0.18
        : 1 + Math.sin(t * 6 + e.phase) * 0.06;
      const glowBase = hasRealLight ? 0.3 : 0.85;
      const glowOpacity = day ? 0 : nf * glowBase * glowFlicker;
      e.glow.position.copy(e.worldPos);
      e.glow.material.opacity = glowOpacity;
      e.glow.visible = glowOpacity > 0.01;

      if (e.flame) {
        // A lit campfire always shows a small flame; it grows and brightens at night.
        const flick = 0.85 + Math.sin(t * 15 + e.phase) * 0.12 + Math.sin(t * 27 + e.phase * 1.9) * 0.07;
        e.flame.position.copy(e.worldPos);
        e.flame.scale.set(0.4 * (0.92 + (flick - 0.85) * 0.5), (0.5 + nf * 0.5) * flick, 1);
        e.flame.material.opacity = (0.5 + nf * 0.42) * flick;
        e.flame.visible = true;
      }
    }
  }

  /** Fill the light budget from the nearest emitters, with 15%-closer hysteresis so
   *  the active set doesn't pop as the camera drifts between equidistant sources. */
  private assignLanternBudget(emitters: LanternEmitter[], assigned: LanternEmitter[], budget: number) {
    for (let i = assigned.length - 1; i >= 0; i--) {
      if (!emitters.includes(assigned[i])) assigned.splice(i, 1);
    }
    while (assigned.length < budget) {
      let best: LanternEmitter | null = null;
      for (const e of emitters) {
        if (assigned.includes(e)) continue;
        if (!best || e.dist < best.dist) best = e;
      }
      if (!best) break;
      assigned.push(best);
    }
    for (let guard = 0; guard <= budget; guard++) {
      let furthest: LanternEmitter | null = null;
      for (const e of assigned) if (!furthest || e.dist > furthest.dist) furthest = e;
      let nearestOut: LanternEmitter | null = null;
      for (const e of emitters) {
        if (assigned.includes(e)) continue;
        if (!nearestOut || e.dist < nearestOut.dist) nearestOut = e;
      }
      if (furthest && nearestOut && nearestOut.dist < furthest.dist * 0.85) {
        assigned[assigned.indexOf(furthest)] = nearestOut;
      } else {
        break;
      }
    }
  }

  private clearLanternEmitters() {
    for (const e of this.lanternEmitters) {
      this.lanternRoot.remove(e.glow);
      e.glow.material.dispose();
      if (e.flame) {
        this.lanternRoot.remove(e.flame);
        e.flame.material.dispose();
      }
    }
    this.lanternEmitters.length = 0;
    this.assignedLanterns.length = 0;
    this.assignedCampfires.length = 0;
    for (const light of this.lanternLightPool) { light.visible = false; light.intensity = 0; }
    for (const light of this.campfireLightPool) { light.visible = false; light.intensity = 0; }
  }

  private returnToLobbyAfterLoss(kills: number, gold: number, reason = 'Defeated') {
    // In multiplayer mode: don't disconnect or auto-respawn. Show the death screen
    // with a "Return to Port" button. The server-side match_ended will deliver the
    // full leaderboard when (or if) the round actually ends.
    this.ui.deathStats.innerHTML = `<div>${reason}</div><div>Kills: ${kills}</div><div>Gold: ${gold}</div>`;
    this.ui.deathScreen.classList.add('visible');
    this.ui.deathScreen.style.display = 'flex';
  }

  private goBackToMenuFromMatch(): void {
    this.network.returnToMenu();
    this.inMatch = false;
    this.endmatchPending = false;
    this.ui.deathScreen.classList.remove('visible');
    this.ui.deathScreen.style.display = 'none';
    this.ui.winScreen.classList.remove('visible');
    this.ui.winScreen.style.display = 'none';
    document.getElementById('hud')?.classList.remove('visible');
    this.menu.hideEndmatch();
    this.menu.show();
    this.resetLocalRoundState();
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
        const local = this.getLocalPlayer();
        if (local?.carryingChestId) return;
        if (local && local.pocketUseCooldown > 0) return;
        if (this.pocketUsePreviewTimer > 0) return;
        this.input.queueWheelSlot(slot);
        this.startPocketUsePreview(slot);
      });
    }
  }

  private bindNetworkEvents() {
    this.network.onJoin = (playerId, shipId, snapshot) => {
      this.clearJoinAssignmentWatchdog();
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

    this.network.onPlayerDowned = (payload) => {
      const isMe = payload.playerId === this.localPlayerId;
      const byWho = payload.attackerName ? ` by ${payload.attackerName}` : '';
      this.pushFeed(
        isMe ? `You were downed${byWho} — a crewmate can revive you!` : `${payload.playerName} was downed${byWho}`,
        isMe ? '#ff8a7a' : '#e0b090',
      );
    };
    this.network.onReviveComplete = (payload) => {
      const isMe = payload.playerId === this.localPlayerId;
      const byWho = payload.reviverName ? ` by ${payload.reviverName}` : '';
      this.pushFeed(
        isMe ? `You were revived${byWho}!` : `${payload.playerName} was revived${byWho}`,
        '#7ce38b',
      );
    };
    this.network.onHotSnapshot = (hot) => {
      this.applyHotSnapshot(hot);
    };
    this.network.onSnapshot = (snapshot) => {
      this.applySnapshot(snapshot);
    };

    this.network.onPlayerHit = (payload) => {
      const hitPayload = payload as {
        damage?: number;
        position?: { x: number; y: number; z: number };
        sourcePosition?: { x: number; y: number; z: number };
        headshot?: boolean;
        kill?: boolean;
        weaponId?: WeaponId | string;
        targetType?: 'player' | 'shark' | 'wildlife';
        incoming?: boolean;
        attackerName?: string;
        meat?: number;
      };
      if (hitPayload.incoming) {
        this.handleIncomingHit(hitPayload);
        this.audio.playPlayerHurt(hitPayload.damage ?? 10);
      } else {
        this.handleCombatHit(hitPayload);
        if (hitPayload.kill) {
          this.audio.playKill();
        } else {
          this.audio.playHitMarker(Boolean(hitPayload.headshot));
        }
      }
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

    this.network.onShipDamage = (payload) => {
      // Broadcast to everyone in range: victims and bystanders see the hit
      // splinter where the ball actually struck ('ship_hit' stays the
      // attacker-only confirm with hitmarker + sound).
      const hit = payload as { attackerId?: string | null; position?: { x: number; y: number; z: number }; projectileType?: string };
      if (!hit.position || hit.attackerId === this.localPlayerId) return;
      this.combatFx.emitShipHitConfirm(hit.position, this.renderer.camera.position);
    };

    this.network.onKillEvent = (payload) => {
      const event = payload as {
        killerId?: string | null;
        victimName?: string;
        killerName?: string | null;
        respawning?: boolean;
        headshot?: boolean;
        boardingKill?: boolean;
        shipSink?: boolean;
        stolenGold?: number;
        killGold?: number;
        headshotGold?: number;
        killerStreak?: number;
        streakReward?: { type?: string; label?: string } | null;
      };
      if (event.killerName && event.victimName) {
        const details = [
          event.headshot ? 'headshot' : '',
          event.boardingKill ? 'boarding raid' : '',
          event.shipSink ? 'ship sunk' : '',
          event.killerStreak && event.killerStreak > 1 ? `${event.killerStreak} streak` : '',
          event.killGold ? `+${event.killGold} kill gold` : '',
          event.headshotGold ? `+${event.headshotGold} headshot` : '',
          event.stolenGold ? `+${event.stolenGold} stolen` : '',
        ].filter(Boolean).join(' · ');
        this.pushFeed(
          `${event.killerName} ${event.shipSink ? 'sank' : 'dropped'} ${event.victimName}${details ? ` (${details})` : ''}${event.respawning ? ', but they will respawn.' : '.'}`,
        );
        if (event.killerId === this.localPlayerId && event.streakReward?.label) {
          this.pushFeed(`${event.streakReward.label}.`, '#7fe7ff');
        }
      } else {
        this.pushFeed(event.victimName ? `${event.victimName} went under.` : 'A pirate was eliminated.');
      }
    };

    this.network.onKegExploded = (payload) => {
      const event = payload as { position?: { x: number; y: number; z: number }; mega?: boolean };
      if (event.position) {
        this.combatFx.emitKegExplosion(event.position, this.renderer.camera.position);
        if (event.mega) {
          this.combatFx.emitKegExplosion(
            { x: event.position.x, y: event.position.y + 0.7, z: event.position.z },
            this.renderer.camera.position,
          );
          this.pushFeed('Mega keg detonated for 5x ship damage.', '#ff9d6f');
        }
      }
    };

    this.network.onChestOpened = (payload) => {
      const event = payload as { action?: string; value?: number; loot?: Array<{ item: string; qty: number }> };
      if (event.action === 'pickup') {
        this.pushFeed(`Chest taken: base ${event.value ?? 0} gold, Hoarders pay more.`, '#d9c17e');
        // The carryingChestId edge-detector also fires for the local player; this covers other crew.
        return;
      }
      if (event.action === 'stow') {
        this.pushFeed(`Chest stowed aboard: base ${event.value ?? 0} gold before Hoarder payout.`, '#d9c17e');
        return;
      }
      if (event.action === 'drop') {
        this.pushFeed(`Chest dropped: base ${event.value ?? 0} gold.`, '#d9c17e');
        return;
      }
      const loot = (event.loot ?? [])
        .slice(0, 2)
        .map((entry) => `${entry.qty} ${entry.item.replace(/_/g, ' ')}`)
        .join(', ');
      this.pushFeed(loot ? `Treasure seized: ${loot}` : 'Treasure chest opened.', '#d9c17e');
      this.audio.playChestOpen();
    };

    this.network.onBarrelOpened = (payload) => {
      const event = payload as {
        playerId?: string;
        barrelId?: string;
        loot?: Array<{ item: string; qty: number }>;
        taken?: boolean;
      };
      const isLocal = event.playerId === this.localPlayerId;
      const loot = (event.loot ?? []).map((entry) => ({ item: entry.item as ItemStack['item'], qty: entry.qty }));
      if (isLocal) {
        if (event.taken) {
          // Player committed — close the panel
          this.barrelBrowse = null;
        } else if (event.barrelId) {
          // Browsing — show the side-by-side panel
          this.barrelBrowse = { barrelId: event.barrelId, loot, lastEventAt: performance.now() };
        }
      }
      const summary = loot
        .slice(0, 2)
        .map((entry) => `${entry.qty} ${entry.item.replace(/_/g, ' ')}`)
        .join(', ');
      const verb = event.taken ? 'Took' : 'Inspecting';
      this.pushFeed(summary ? `${verb} barrel: ${summary}` : `${verb} barrel.`, '#9ec0e5');
    };

    this.network.onShipUpgraded = (payload) => {
      const event = payload as { shipId?: string; type?: ShipUpgradeType };
      if (!event.type) return;
      const meta = this.getUpgradePresentation(event.type);
      const isOwn = event.shipId === this.localShipId;
      const subject = isOwn ? 'Your ship claimed' : 'A crew claimed';
      this.pushFeed(`${subject} ${meta.name}.`, meta.color);
      if (isOwn) this.audio.playUpgradeBought();
    };

    this.network.onTreasureSold = (payload) => {
      const event = payload as {
        playerName?: string;
        playerId?: string;
        gold?: number;
        questBonus?: boolean;
        totalGold?: number;
        islandName?: string;
      };
      const seller = event.playerName ?? 'A pirate';
      const bonus = event.questBonus ? ' with map bonus' : '';
      this.pushFeed(
        `${seller} sold a chest${bonus} for ${event.gold ?? 0} gold (${event.totalGold ?? 0}/${ECONOMY.GOLD_WIN_TARGET}).`,
        '#f0c86a',
      );
      if (event.playerId === this.localPlayerId || (event.playerName && this.getLocalPlayer()?.name === event.playerName)) {
        this.audio.playGoldEarn();
      }
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
        this.audio.playDefeat();
        this.returnToLobbyAfterLoss(result.kills ?? player?.kills ?? 0, result.gold ?? player?.gold ?? 0, 'Crew lost');
      } else if (result.winnerId && result.winnerId === this.localPlayerId) {
        this.audio.playVictory();
        this.showVictory(player?.kills ?? 0, result.gold ?? player?.gold ?? 0);
      } else {
        this.audio.playDefeat();
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
        if (event.mermaid) {
          this.mermaidAnchor = null;
          if (this.mermaidGroup.visible) this.mermaidGroup.visible = false;
          this.pushFeed('The mermaid returned you to your ship.', '#8bc2d7');
        }
      }
    };


    this.network.onMatchEnded = (payload) => {
      const result = payload as {
        winnerId: string | null;
        winnerName: string | null;
        reason: string;
        humans: Array<{ playerId: string; name: string; kills: number; deaths: number; gold: number; placement: number; isWinner: boolean }>;
      };
      this.endmatchPending = true;
      const youId = this.localPlayerId;
      const youRow = result.humans.find((r) => r.playerId === youId);
      const won = !!result.winnerId && result.winnerId === youId;
      const subtitle = result.reason === 'gold'
        ? `${result.winnerName ?? 'A pirate'} amassed enough gold`
        : result.reason === 'last_ship'
          ? 'Last crew afloat takes the seas'
          : 'The voyage ended';
      this.menu.showEndmatch({
        isWinner: won,
        title: won ? 'VICTORY' : (youRow?.deaths ? 'DEFEATED' : 'VOYAGE ENDED'),
        subtitle,
        rows: result.humans.map((r) => ({
          placement: r.placement,
          name: r.name,
          kills: r.kills,
          deaths: r.deaths,
          gold: r.gold,
          you: r.playerId === youId,
          winner: r.isWinner,
        })),
      });
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
      targetType?: 'player' | 'shark' | 'wildlife';
      remainingHull?: number;
      shipHealthMilestone?: 'half' | 'critical' | null;
      meat?: number;
    },
    ship = false,
  ) {
    const damage = Math.max(1, Math.round(payload.damage ?? 0));
    const shark = payload.targetType === 'shark';
    const wildlife = payload.targetType === 'wildlife';
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
    if (wildlife && payload.kill && (payload.meat ?? 0) > 0) {
      this.pushFeed(`Harvested ${payload.meat} meat.`, '#d7b48a');
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

  private handleIncomingHit(payload: {
    damage?: number;
    sourcePosition?: { x: number; y: number; z: number };
    headshot?: boolean;
    kill?: boolean;
    weaponId?: WeaponId | string;
    attackerName?: string;
  }) {
    const damage = Math.max(1, Math.round(payload.damage ?? 0));
    const wid = payload.weaponId;
    const weaponLabel = wid && wid in WEAPONS
      ? WEAPONS[wid as WeaponId].name
      : wid === 'powder_keg'
        ? 'Powder Keg'
        : 'attack';
    const attacker = payload.attackerName?.trim() || 'Enemy';
    const critical = payload.headshot ? ' headshot' : '';
    this.pushFeed(`Hit by ${attacker}${critical} - ${damage} (${weaponLabel})`, payload.headshot ? '#ff8f6d' : '#ffb37a');
    if (payload.sourcePosition) this.spawnIncomingDamageDirection(payload.sourcePosition);
  }

  private spawnIncomingDamageDirection(sourcePosition: { x: number; y: number; z: number }) {
    this.tempHudVector.set(sourcePosition.x, sourcePosition.y, sourcePosition.z).project(this.renderer.camera);
    const angle = Math.atan2(this.tempHudVector.x, -this.tempHudVector.y);
    const element = document.createElement('div');
    element.className = 'incoming-damage-arrow';
    element.style.setProperty('--hit-angle', `${angle}rad`);
    this.ui.damageIndicatorLayer.appendChild(element);
    window.setTimeout(() => element.remove(), 760);
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
    const hasFreshIslandState = snapshot.islands.length > 0 || !this.state;
    // Static world (islands + seaRocks) rides only every 4th full snapshot on
    // the wire — preserve the previous copies on the ticks that omit them.
    const nextSnapshot = this.state && (snapshot.islands.length === 0 || (snapshot.seaRocks?.length ?? 0) === 0)
      ? {
        ...snapshot,
        islands: snapshot.islands.length === 0 ? this.state.islands : snapshot.islands,
        seaRocks: (snapshot.seaRocks?.length ?? 0) === 0 ? this.state.seaRocks : snapshot.seaRocks,
      }
      : snapshot;
    const previousLocalState = this.getLocalPlayer()?.state ?? this.previousLocalState;
    this.state = nextSnapshot;
    this.rebuildStateIndexes(nextSnapshot);
    this.lastSnapshotAt = performance.now();
    if (Number.isFinite(nextSnapshot.serverTime)) {
      const offset = nextSnapshot.serverTime - performance.now() / 1000;
      this.serverTimeOffset = this.serverTimeOffset === null
        ? offset
        : this.serverTimeOffset + (offset - this.serverTimeOffset) * 0.1;
    }
    if (hasFreshIslandState) {
      this.ensureWorldMeshes(nextSnapshot);
      this.syncChests();
      this.syncBarrels();
    }
    this.updateStormRing();
    this.updateDamageFx();
    this.syncTradeUi(nextSnapshot);
    const localPlayer = this.getLocalPlayer();
    if (localPlayer && previousLocalState === 'respawning' && localPlayer.state === 'alive') {
      this.combatFx.emitRespawn(localPlayer.position, this.renderer.camera.position);
    }
    this.previousLocalState = localPlayer?.state ?? null;
  }

  /** Merge a 31Hz 'state_hot' transform update into the last full snapshot.
   *  Hot payloads carry only moving-entity transforms (plus storm), so ships,
   *  players and projectiles glide at full rate while the heavyweight world
   *  state arrives at ~10Hz — this is what fixed the ~1s snapshot starvation. */
  private applyHotSnapshot(hot: HotSnapshotPayload) {
    const state = this.state;
    if (!state) return; // need one full snapshot first
    if (hot.tick < state.tick) return; // stale hot arriving after a newer full
    state.tick = hot.tick;
    state.serverTime = hot.serverTime;
    state.shipsAlive = hot.shipsAlive;
    state.storm = hot.storm;
    for (const h of hot.ships) {
      const ship = this.shipsById.get(h.id);
      if (!ship) continue;
      ship.position = h.position;
      ship.rotation = h.rotation;
      ship.velocity = h.velocity;
      ship.angularVelocity = h.angularVelocity;
      ship.pitch = h.pitch;
      ship.roll = h.roll;
      ship.heave = h.heave;
      if (h.rudderAngle !== undefined) ship.rudderAngle = h.rudderAngle;
      ship.sailHeight = h.sailHeight;
      ship.sailAngle = h.sailAngle;
      ship.sinking = h.sinking;
      ship.sinkProgress = h.sinkProgress;
      if (h.waterLevel !== undefined) ship.waterLevel = h.waterLevel;
      if (h.floodingRate !== undefined) ship.floodingRate = h.floodingRate;
    }
    for (const h of hot.players) {
      const player = this.playersById.get(h.id);
      if (!player) continue;
      player.position = h.position;
      player.rotation = h.rotation;
      player.velocity = h.velocity;
      player.health = h.health;
      player.state = h.state;
      player.onShipId = h.onShipId;
      player.cutlassCharge = h.cutlassCharge;
      player.downedUntil = h.downedUntil;
      player.reviveProgress = h.reviveProgress;
    }
    for (const h of hot.projectiles) {
      for (const projectile of state.projectiles) {
        if (projectile.id === h.id) {
          projectile.position = h.position;
          projectile.velocity = h.velocity;
          break;
        }
      }
    }
    for (const h of hot.kegs) {
      for (const keg of state.kegs) {
        if (keg.id === h.id) {
          keg.position = h.position;
          keg.timer = h.timer;
          break;
        }
      }
    }
    for (const h of hot.sharks) {
      for (const shark of state.sharks ?? []) {
        if (shark.id === h.id) {
          shark.position = h.position;
          shark.rotation = h.rotation;
          shark.health = h.health;
          break;
        }
      }
    }
    this.lastSnapshotAt = performance.now();
    if (Number.isFinite(hot.serverTime)) {
      const offset = hot.serverTime - performance.now() / 1000;
      this.serverTimeOffset = this.serverTimeOffset === null
        ? offset
        : this.serverTimeOffset + (offset - this.serverTimeOffset) * 0.1;
    }
  }

  private rebuildStateIndexes(state: GameState) {
    this.playersById.clear();
    for (const player of state.players) this.playersById.set(player.id, player);
    this.shipsById.clear();
    for (const ship of state.ships) this.shipsById.set(ship.id, ship);
    this.livePlayerIds.clear();
    for (const player of state.players) this.livePlayerIds.add(player.id);
    this.liveProjectileIds.clear();
    for (const projectile of state.projectiles) {
      if (projectile.alive) this.liveProjectileIds.add(projectile.id);
    }
    this.liveKegIds.clear();
    for (const keg of state.kegs) {
      if (keg.timer > 0) this.liveKegIds.add(keg.id);
    }
  }

  /** Islands still waiting to be built, drained a few per frame so joining a
   *  match never freezes the main thread for seconds (10 islands × a heavy
   *  buildIsland used to run synchronously inside the ws message handler). */
  private pendingIslandBuilds: Island[] = [];

  private ensureWorldMeshes(state: GameState) {
    let islandsQueued = false;
    for (const island of state.islands) {
      if (!this.islandMeshes.has(island.id)
        && !this.pendingIslandBuilds.some((queued) => queued.id === island.id)) {
        this.pendingIslandBuilds.push(island);
        islandsQueued = true;
      }
    }
    if (islandsQueued) {
      // Nearest islands first so the spawn area appears immediately.
      const cam = this.renderer.camera.position;
      this.pendingIslandBuilds.sort((a, b) =>
        this.distance2D(cam.x, cam.z, a.position.x, a.position.z)
        - this.distance2D(cam.x, cam.z, b.position.x, b.position.z));
      // Elliptical footprints: foam/shallows/damping land at the real
      // waterline (the old circle-of-roster-radius buried the foam band tens
      // of meters inside the beach).
      this.ocean.setIslands(state.islands.map((i) => ({
        x: i.position.x,
        z: i.position.z,
        rx: i.radius * i.profile.footprintX,
        rz: i.radius * i.profile.footprintZ,
      })));
      // Build the two closest synchronously so the player never sees a bare
      // horizon at spawn; the rest stream in over the next frames.
      this.drainIslandBuildQueue(2);
    }
    for (const rock of state.seaRocks ?? []) {
      if (!this.seaRockMeshes.has(rock.id)) {
        const mesh = this.buildSeaRockMesh(rock);
        this.environment.add(mesh);
        this.seaRockMeshes.set(rock.id, mesh);
      }
    }
  }

  /** Build up to `count` queued islands (called once per frame from the main
   *  loop with count=1, and from ensureWorldMeshes for the spawn area). */
  drainIslandBuildQueue(count = 1) {
    for (let i = 0; i < count && this.pendingIslandBuilds.length > 0; i++) {
      const island = this.pendingIslandBuilds.shift()!;
      if (!this.islandMeshes.has(island.id)) this.buildIsland(island);
    }
  }

  private buildSeaRockMesh(rock: SeaRock) {
    const group = new THREE.Group();
    group.name = `sea-rock-${rock.id}`;
    group.position.set(rock.position.x, rock.position.y, rock.position.z);
    group.rotation.y = rock.rotation;
    const lowDetail = this.renderer.getQuality() === 'low';

    // GLB sea spires by size tier, fitted inside the server collider envelope
    // (main collider cylinder) so visuals never exceed the collision size.
    const tier: AssetName = rock.height > 26 ? 'searock_b' : rock.height > 13 ? 'searock_a' : 'searock_c';
    const rockClone = assets.clone(tier);
    const rockBounds = assets.bounds(tier);
    if (rockClone && rockBounds) {
      const assetHoriz = Math.max(-rockBounds.min.x, rockBounds.max.x, -rockBounds.min.z, rockBounds.max.z, 0.001);
      const mainColliderRadius = rock.variant === 1 ? rock.radius * 0.72 : rock.radius * (0.62 + rock.variant * 0.035);
      const mainColliderTop = rock.height * (rock.variant === 1 ? 0.84 : 0.94) - 1.3;
      const sxz = mainColliderRadius / assetHoriz;
      const sy = Math.max(0.4, mainColliderTop / Math.max(rockBounds.max.y, 0.001));
      rockClone.scale.set(sxz, sy, sxz);
      if (lowDetail) {
        rockClone.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = false;
            o.receiveShadow = false;
          }
        });
      }
      group.add(rockClone);

      const foam = new THREE.Mesh(
        new THREE.RingGeometry(rock.radius * 0.78, rock.radius * 1.16, lowDetail ? 12 : 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
      );
      foam.rotation.x = -Math.PI * 0.5;
      foam.position.y = 0.04;
      group.add(foam);
      return group;
    }

    const darkMat = new THREE.MeshStandardMaterial({ color: 0x292d2b, roughness: 1, flatShading: true });
    const wetMat = new THREE.MeshStandardMaterial({ color: 0x3c403a, roughness: 0.92, flatShading: true });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x595548, roughness: 0.98, flatShading: true });
    const mainGeo = rock.variant === 1
      ? new THREE.ConeGeometry(rock.radius * 0.72, rock.height, 6, 1)
      : new THREE.DodecahedronGeometry(rock.radius * 0.62, 1);
    const main = new THREE.Mesh(mainGeo, rock.variant === 2 ? wetMat : darkMat);
    main.scale.set(1.05, rock.variant === 1 ? 1 : rock.height / Math.max(1, rock.radius), 0.82 + rock.variant * 0.08);
    main.position.y = rock.height * 0.34 - 1.8;
    main.rotation.set(-0.16 + rock.variant * 0.11, 0, 0.09);
    main.castShadow = !lowDetail;
    main.receiveShadow = !lowDetail;
    group.add(main);

    const shardCount = lowDetail ? 1 + Math.min(1, rock.variant) : 4 + rock.variant;
    for (let i = 0; i < shardCount; i++) {
      const angle = (i / shardCount) * Math.PI * 2 + rock.rotation * 0.17;
      const radius = rock.radius * (0.28 + (i % 2) * 0.16);
      const shardH = rock.height * (0.34 + (i % 3) * 0.08);
      const shard = new THREE.Mesh(
        new THREE.ConeGeometry(rock.radius * (0.16 + (i % 2) * 0.04), shardH, 5, 1),
        i % 2 === 0 ? wetMat : topMat,
      );
      shard.position.set(Math.cos(angle) * radius, shardH * 0.28 - 1.2, Math.sin(angle) * radius);
      shard.rotation.set((i % 2 ? 0.24 : -0.18), angle, (i % 3 - 1) * 0.18);
      shard.castShadow = !lowDetail;
      shard.receiveShadow = !lowDetail;
      group.add(shard);
    }

    const foam = new THREE.Mesh(
      new THREE.RingGeometry(rock.radius * 0.78, rock.radius * 1.16, lowDetail ? 12 : 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
    );
    foam.rotation.x = -Math.PI * 0.5;
    foam.position.y = 0.04;
    group.add(foam);

    return group;
  }

  private buildIsland(island: Island) {
    const group = new THREE.Group();
    group.name = `island-${island.name}`;
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
    const visualDetail = this.renderer.getEffectScale();
    const lowDetail = visualDetail < 0.55;
    const scaledCount = (base: number, min: number) => {
      const scale = lowDetail ? visualDetail * 0.28 : visualDetail;
      const floor = lowDetail ? 0 : min;
      return Math.max(floor, Math.round(base * scale));
    };

    const reefMat = new THREE.MeshStandardMaterial({ color: 0x4d4a42, roughness: 1, side: THREE.DoubleSide });
    const cliffMat = new THREE.MeshStandardMaterial({ color: 0x564f3f, roughness: 0.98, side: THREE.DoubleSide });
    // Biome palette drives per-island vertex + foliage colors so a volcanic isle
    // reads dark and ashen while a lush one reads verdant and a bone atoll reads
    // pale. MapGenerator copies profile.palette from BIOME_PALETTES; fall back to
    // the biome table (then lush) if a profile predates the palette field.
    const palette = island.profile.palette
      ?? BIOME_PALETTES[island.profile.biome ?? 'lush']
      ?? BIOME_PALETTES.lush;
    const paletteSand = new THREE.Color(palette.sand);
    const paletteGrass = new THREE.Color(palette.grass);
    const paletteRock = new THREE.Color(palette.rock);
    const paletteFoliage = new THREE.Color(palette.foliage);
    // Beach sand read as a flat near-white halo ringing sunlit islands
    // (patrol-3): pull the whitening way back and warm/darken the base so it's
    // sand, not a bloom band.
    const beachColor = paletteSand.clone().lerp(new THREE.Color(0xffffff), 0.05);
    const sandColor = paletteSand.clone().multiplyScalar(0.9);
    const grassColor = paletteGrass.clone();
    const jungleColor = paletteFoliage.clone();
    const peakColor = paletteGrass.clone().lerp(paletteRock, 0.42);
    const cliffColor = paletteRock.clone().lerp(new THREE.Color(0xffffff), 0.06);
    const mudColor = paletteRock.clone().lerp(paletteFoliage, 0.3);
    const boulderMat = new THREE.MeshStandardMaterial({ color: paletteRock.clone().lerp(new THREE.Color(0xffffff), 0.08).getHex(), roughness: 1 });
    const driftwoodMat = new THREE.MeshStandardMaterial({ color: 0xc4b08a, roughness: 1 });
    const bambooMat = new THREE.MeshStandardMaterial({ color: 0x72b040, roughness: 0.8 });
    const wreckMat = new THREE.MeshStandardMaterial({ color: 0x4b2f16, roughness: 1, map: null });
    const canvasMat = new THREE.MeshStandardMaterial({ color: 0xc9b57d, roughness: 0.96, side: THREE.DoubleSide });
    const shrineMat = new THREE.MeshStandardMaterial({ color: 0x625846, roughness: 1 });
    const boulderGeo = new THREE.DodecahedronGeometry(0.9, 0);
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
      const tr = Math.max(0.01, Number.isFinite(config.topRadius) ? config.topRadius : 0.01);
      const br = Math.max(0.01, Number.isFinite(config.bottomRadius) ? config.bottomRadius : 0.01);
      const h = Math.max(0.01, Number.isFinite(config.height) ? config.height : 0.01);
      const geometry = new THREE.CylinderGeometry(
        tr,
        br,
        h,
        Math.max(3, Math.floor((config.radialSegments ?? 24) * visualDetail)),
        Math.max(1, Math.floor((config.heightSegments ?? 5) * (lowDetail ? 0.6 : visualDetail))),
      );
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const vertex = new THREE.Vector3();

      for (let index = 0; index < position.count; index++) {
        vertex.fromBufferAttribute(position, index);
        const angle = Math.atan2(vertex.z, vertex.x);
        const baseRadius = Math.hypot(vertex.x, vertex.z);
        // Clamp: rounding can put the top row at 1.0000000000000002, and
        // Math.pow(1 - y01, 1.35) with a negative base is NaN — which
        // silently corrupted the reef layer on 3 of 14 islands.
        const y01 = THREE.MathUtils.clamp((vertex.y + h * 0.5) / h, 0, 1);
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
        const drift = (y01 - 0.5) * (config.lean ?? 0.02) * h;
        if (baseRadius > 0.0001) {
          vertex.x = Math.cos(angle) * baseRadius * radialScale * (config.scaleX ?? 1) + (config.massOffsetX ?? 0) + Math.cos(islandHeading) * drift;
          vertex.z = Math.sin(angle) * baseRadius * radialScale * (config.scaleZ ?? 1) + (config.massOffsetZ ?? 0) + Math.sin(islandHeading) * drift;
          vertex.y += (lobeA * 0.06 + lobeB * 0.04) * h * (0.3 + y01);
        } else {
          vertex.x += (config.massOffsetX ?? 0);
          vertex.z += (config.massOffsetZ ?? 0);
        }
        position.setXYZ(index, vertex.x, vertex.y, vertex.z);
      }

      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, config.material);
      mesh.position.y = Number.isFinite(config.y) ? config.y : 0;
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
    const SURFACE_ABOVE_WATER = 5.0;
    const isSolidDecorPoint = (point: THREE.Vector3, minY = SURFACE_ABOVE_WATER, margin = -0.35) => (
      point.y >= minY
      && isPointInsideIslandFootprint(
        island,
        point.x + island.position.x,
        point.z + island.position.z,
        margin,
      )
    );

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
    const terrainIndices: number[] = [];
    // Mesh density scales with the island's real footprint so the shared
    // heightfield's fbm knolls, ridged cliff bands, and 2.4-6m terraces
    // actually resolve instead of aliasing into a smooth dome. A 56x160 cap is
    // ~9k verts — trivial for a landmark mesh.
    const islandMaxR = getIslandMaxRadius(island);
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

    for (let ring = 0; ring <= totalRings; ring++) {
      const distRatio = ringDistRatio(ring);
      for (let segment = 0; segment <= angularSegments; segment++) {
        const angle = (segment / angularSegments) * Math.PI * 2;
        const point = surfacePoint(distRatio, angle, 0.02);
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
    const wetSandColor = sandColor.clone().multiplyScalar(0.62).lerp(new THREE.Color(0x2e5d63), 0.22);
    const submergedColor = new THREE.Color(0x1d4a52);
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
        const shoreMask = THREE.MathUtils.smoothstep(distRatio, 0.72, 0.99);
        const grassMask = THREE.MathUtils.smoothstep(heightNorm, 0.02, 0.42)
          * (1 - THREE.MathUtils.smoothstep(distRatio, 0.78, 0.98));
        const jungleMask = THREE.MathUtils.smoothstep(heightNorm, 0.08, 0.4)
          * (1 - THREE.MathUtils.smoothstep(distRatio, 0.55, 0.82)) * 0.75;
        // Rock is earned by SLOPE first; only genuinely high ground rock-caps.
        const rockMask = THREE.MathUtils.smoothstep(heightNorm, 0.72, 0.97) * (1 - shoreMask * 0.6) * 0.55;
        const peakMask = THREE.MathUtils.smoothstep(heightNorm, 0.88, 1) * 0.4;
        const mudMask = THREE.MathUtils.smoothstep(distRatio, 0.62, 0.78) * (1 - shoreMask) * 0.25;
        const slopeRockMask = THREE.MathUtils.smoothstep(slope, 0.26, 0.6) * (1 - shoreMask);

        terrainColor.copy(sandColor);
        terrainColor.lerp(beachColor, shoreMask * coast.beach * 0.95);
        terrainColor.lerp(cliffColor, shoreMask * rockyCoast * 0.75);
        terrainColor.lerp(mudColor, mudMask);
        terrainColor.lerp(grassColor, grassMask);
        terrainColor.lerp(jungleColor, jungleMask);
        terrainColor.lerp(cliffColor, rockMask);
        terrainColor.lerp(rockSlopeColor, slopeRockMask * 0.85);
        terrainColor.lerp(peakColor, peakMask * (1 - slopeRockMask));
        scratchColor.copy(beachColor).multiplyScalar(THREE.MathUtils.smoothstep(distRatio, 0.9, 1) * 0.14);
        terrainColor.add(scratchColor);

        // Waterline gradient on the new shore rings: dry sand → darker wet
        // sand at the lapping band → blue-green submerged slope, so the
        // beach visually walks into the sea.
        const wetMask = THREE.MathUtils.smoothstep(-pointY, -0.55, 0.25);
        const depthMask = THREE.MathUtils.smoothstep(-pointY, 0.2, 2.6);
        if (wetMask > 0) {
          terrainColor.lerp(wetSandColor, wetMask * (0.45 + coast.beach * 0.35));
          terrainColor.lerp(submergedColor, depthMask * 0.8);
        }

        // Per-vertex noise + a low-frequency hue drift so large faces never
        // read as one flat paint bucket (survives ACES tonemapping). Sand
        // (near shore) gets extra tonal variation so beaches don't clip to a
        // uniform bright halo.
        const sandiness = shoreMask * coast.beach;
        const vnoise = (rng(ring * 113 + segment * 17) - 0.5) * (0.07 + sandiness * 0.06);
        const hueDrift = Math.sin(angle * 3.1 + distRatio * 5.3 + r * 0.13) * 0.03;
        terrainColors.push(
          THREE.MathUtils.clamp(terrainColor.r + vnoise * 0.5 - hueDrift * 0.4, 0, 1),
          THREE.MathUtils.clamp(terrainColor.g + vnoise + hueDrift, 0, 1),
          THREE.MathUtils.clamp(terrainColor.b + vnoise * 0.3 - hueDrift * 0.5, 0, 1),
        );
      }
    }
    terrainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(terrainColors, 3));

    const terrain = new THREE.Mesh(
      terrainGeometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, side: THREE.DoubleSide }),
    );
    terrain.name = 'island-terrain';
    terrain.castShadow = true;
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

    // Server prop registry: the palms/boulders/landmarks players collide with.
    this.buildServerProps(island, group, lowDetail);

    // ── Grass: one InstancedMesh of cross-plane tufts over the grassy interior.
    // Deterministic from the profile seed; culled with the micro tier past
    // ~260m; zero colliders (ankle-high ground cover).
    if (!lowDetail) {
      const grassCount = Math.min(2600, Math.round(r * r * 0.3));
      const bladeGeo = new THREE.PlaneGeometry(0.4, 0.5, 1, 1);
      bladeGeo.translate(0, 0.25, 0);
      const crossGeo = (() => {
        const a = bladeGeo.clone();
        const b = bladeGeo.clone();
        b.rotateY(Math.PI * 0.5);
        const merged = new THREE.BufferGeometry();
        const pa = a.getAttribute('position');
        const pb = b.getAttribute('position');
        const uva = a.getAttribute('uv');
        const uvb = b.getAttribute('uv');
        const positions = new Float32Array((pa.count + pb.count) * 3);
        positions.set(pa.array as Float32Array, 0);
        positions.set(pb.array as Float32Array, pa.count * 3);
        const uvs = new Float32Array((uva.count + uvb.count) * 2);
        uvs.set(uva.array as Float32Array, 0);
        uvs.set(uvb.array as Float32Array, uva.count * 2);
        const idxA = Array.from(a.getIndex()!.array);
        const idxB = Array.from(b.getIndex()!.array).map((i) => i + pa.count);
        merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        merged.setIndex([...idxA, ...idxB]);
        merged.computeVertexNormals();
        return merged;
      })();
      // White base: per-instance colors MULTIPLY material.color — a tinted
      // base squared every tuft toward black (the 'invisible grass' bug).
      const grassMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: makeGrassBladeTexture(),
        roughness: 0.94,
        side: THREE.DoubleSide,
        alphaTest: 0.42,
        transparent: false,
      });
      const grass = new THREE.InstancedMesh(crossGeo, grassMat, grassCount);
      const gM = new THREE.Matrix4();
      const gP = new THREE.Vector3();
      const gQ = new THREE.Quaternion();
      const gE = new THREE.Euler();
      const gS = new THREE.Vector3();
      const gColor = new THREE.Color();
      const seaBaseForGrass = 5.15 + r * 0.0085;
      let placed = 0;
      for (let i = 0; i < grassCount * 3 && placed < grassCount; i++) {
        const angle = rng(i * 7 + 3) * Math.PI * 2;
        const dRatio = 0.06 + rng(i * 11 + 5) * 0.78;
        const sample = surfacePoint(dRatio, angle, 0);
        // grassy band: above the beach, below the rocky heights, not too steep
        if (sample.y < seaBaseForGrass - 1.6) continue;
        if (sample.y > seaBaseForGrass + peakEst * 0.95) continue;
        const ahead = surfacePoint(dRatio + 0.015, angle, 0);
        if (Math.abs(ahead.y - sample.y) > 0.9) continue;
        gP.set(sample.x, sample.y - 0.06, sample.z);
        gE.set((rng(i * 13) - 0.5) * 0.3, rng(i * 17) * Math.PI, (rng(i * 19) - 0.5) * 0.3);
        gQ.setFromEuler(gE);
        const sc = 0.7 + rng(i * 23) * 0.9;
        gS.set(sc, sc * (0.8 + rng(i * 29) * 0.5), sc);
        gM.compose(gP, gQ, gS);
        grass.setMatrixAt(placed, gM);
        gColor.copy(paletteGrass).lerp(paletteFoliage, rng(i * 31) * 0.6).multiplyScalar(1.05 + rng(i * 37) * 0.45);
        grass.setColorAt(placed, gColor);
        placed += 1;
      }
      grass.count = placed;
      grass.instanceMatrix.needsUpdate = true;
      if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
      grass.castShadow = false;
      grass.receiveShadow = true;
      grass.name = 'island-grass';
      group.add(grass);

      // ── Ferns: taller arched fronds in the shaded inner jungle band ──
      const fernCount = Math.min(380, Math.round(r * r * 0.035));
      const fernGeo = crossGeo.clone();
      fernGeo.scale(1.15, 2.1, 1.15);
      {
        const fpos = fernGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < fpos.count; i++) {
          const fy = fpos.getY(i);
          // arch the tips outward for a frond silhouette
          fpos.setX(i, fpos.getX(i) * (1 + fy * 0.5));
          fpos.setZ(i, fpos.getZ(i) * (1 + fy * 0.5));
        }
        fpos.needsUpdate = true;
      }
      const ferns = new THREE.InstancedMesh(
        fernGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeFernFrondTexture(), roughness: 0.92, side: THREE.DoubleSide, alphaTest: 0.4 }),
        fernCount,
      );
      // Cluster ferns into leafy clumps (2-3 fronds per seed) instead of
      // isolated cards, so they read as bushes/groundcover not scattered
      // cardboard (patrol-3).
      let fernsPlaced = 0;
      for (let seed = 0; seed < fernCount && fernsPlaced < fernCount; seed++) {
        const angle = rng(seed * 41 + 9) * Math.PI * 2;
        const dRatio = 0.05 + rng(seed * 43 + 3) * 0.6;
        const sample = surfacePoint(dRatio, angle, 0);
        if (sample.y < seaBaseForGrass - 0.6 || sample.y > seaBaseForGrass + peakEst * 0.85) continue;
        const clump = 2 + Math.floor(rng(seed * 71) * 2);
        for (let c = 0; c < clump && fernsPlaced < fernCount; c++) {
          const i = seed * 7 + c;
          gP.set(sample.x + (rng(i * 47) - 0.5) * 0.7, sample.y - 0.09, sample.z + (rng(i * 59) - 0.5) * 0.7);
          gE.set((rng(i * 47) - 0.5) * 0.24, rng(i * 53) * Math.PI * 2, (rng(i * 59) - 0.5) * 0.24);
          gQ.setFromEuler(gE);
          const sc = 0.55 + rng(i * 61) * 0.85;
          gS.set(sc, sc, sc);
          gM.compose(gP, gQ, gS);
          ferns.setMatrixAt(fernsPlaced, gM);
          gColor.copy(paletteFoliage).multiplyScalar(0.95 + rng(i * 67) * 0.55);
          ferns.setColorAt(fernsPlaced, gColor);
          fernsPlaced += 1;
        }
      }
      ferns.count = fernsPlaced;
      ferns.instanceMatrix.needsUpdate = true;
      if (ferns.instanceColor) ferns.instanceColor.needsUpdate = true;
      ferns.castShadow = false;
      ferns.receiveShadow = true;
      ferns.name = 'island-ferns';
      group.add(ferns);

      // ── Seashells + starfish flecks on the wet-sand band ──
      const shellCount = Math.min(240, Math.round(r * 2.2));
      const shellGeo = new THREE.SphereGeometry(0.09, 6, 4);
      shellGeo.scale(1.25, 0.4, 1);
      const shells = new THREE.InstancedMesh(
        shellGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72 }),
        shellCount,
      );
      const shellTints = [0xf6efe4, 0xe8cdbf, 0xdfa7a0, 0xc9d8d5, 0xf0dcc2];
      let shellsPlaced = 0;
      for (let i = 0; i < shellCount * 4 && shellsPlaced < shellCount; i++) {
        const angle = rng(i * 71 + 13) * Math.PI * 2;
        const dRatio = 0.86 + rng(i * 73 + 5) * 0.2;
        const sample = surfacePoint(dRatio, angle, 0);
        if (sample.y < 0.06 || sample.y > 1.5) continue; // wet-to-dry sand band only
        gP.set(sample.x, sample.y + 0.015, sample.z);
        gE.set(0, rng(i * 79) * Math.PI * 2, 0);
        gQ.setFromEuler(gE);
        const sc = 0.6 + rng(i * 83) * 1.1;
        gS.set(sc, sc, sc);
        gM.compose(gP, gQ, gS);
        shells.setMatrixAt(shellsPlaced, gM);
        gColor.setHex(shellTints[Math.floor(rng(i * 89) * shellTints.length) % shellTints.length]);
        shells.setColorAt(shellsPlaced, gColor);
        shellsPlaced += 1;
      }
      shells.count = shellsPlaced;
      shells.instanceMatrix.needsUpdate = true;
      if (shells.instanceColor) shells.instanceColor.needsUpdate = true;
      shells.castShadow = false;
      shells.receiveShadow = true;
      shells.name = 'island-shells';
      group.add(shells);
    }

    if (island.dock) {
      const dockW = Math.max(1, Math.min(120, Number(island.dock.width) || 8));
      const dockL = Math.max(1, Math.min(200, Number(island.dock.length) || 14));
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

      // GLB dock modules: walkway runs along the module's local X (6×3 mid,
      // 4×3 end, deck at +1.1); the game dock runs along local Z. Purely a
      // visual swap — server walk/collision math is untouched.
      const dockUsesGlb = assets.has('dock_mid') && assets.has('dock_end');
      if (dockUsesGlb) {
        const MID_LEN = 6;
        const END_LEN = 4;
        const MODULE_W = 3;
        const DECK_H = 1.1;
        const midCount = Math.max(1, Math.round((dockL - END_LEN) / MID_LEN));
        const runLen = midCount * MID_LEN + END_LEN;
        const alongScale = dockL / runLen;
        const widthScale = dockW / MODULE_W;
        // Server walk surface sits at dock.position.y + 0.14; keep the visual deck flush with it.
        const moduleY = 0.18 - DECK_H;
        let cursor = -dockL * 0.5;
        for (let m = 0; m < midCount; m++) {
          const piece = assets.clone('dock_mid');
          if (!piece) break;
          piece.rotation.y = Math.PI * 0.5;
          piece.scale.set(alongScale, 1, widthScale);
          piece.position.set(0, moduleY, cursor + MID_LEN * alongScale * 0.5);
          dock.add(piece);
          cursor += MID_LEN * alongScale;
        }
        const endPiece = assets.clone('dock_end');
        if (endPiece) {
          endPiece.rotation.y = Math.PI * 0.5;
          endPiece.scale.set(alongScale, 1, widthScale);
          endPiece.position.set(0, moduleY, cursor + END_LEN * alongScale * 0.5);
          dock.add(endPiece);
        }
      } else {
        const deck = new THREE.Mesh(
          new THREE.BoxGeometry(dockW, 0.22, dockL),
          dockMat,
        );
        deck.position.y = 0.12;
        deck.castShadow = true;
        deck.receiveShadow = true;
        dock.add(deck);
      }

      const shorePlatform = new THREE.Mesh(
        new THREE.BoxGeometry(dockW * 1.2, 0.24, Math.min(4.6, dockL * 0.3)),
        dockMat,
      );
      shorePlatform.position.set(0, 0.14, -dockL * 0.34);
      shorePlatform.castShadow = true;
      shorePlatform.receiveShadow = true;
      dock.add(shorePlatform);

      const ladderZ = -dockL * 0.46;
      const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95 });
      const rungMat = new THREE.MeshStandardMaterial({ color: 0x6a4828, roughness: 0.92 });
      const side = dockW * 0.22;
      for (const sx of [-side, side] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.1), railMat);
        rail.position.set(sx, 0.72, ladderZ + 0.12);
        rail.castShadow = true;
        dock.add(rail);
      }
      if (!lowDetail) {
        const rungCount = 8;
        for (let r = 0; r < rungCount; r++) {
          const rung = new THREE.Mesh(new THREE.BoxGeometry(side * 2.1, 0.07, 0.12), rungMat);
          rung.position.set(0, 0.18 + r * 0.14, ladderZ + r * 0.04);
          rung.castShadow = true;
          dock.add(rung);
        }

        if (!dockUsesGlb) {
          const plankCount = scaledCount(Math.round(dockW), 4);
          for (let i = 0; i < plankCount; i++) {
            const plank = new THREE.Mesh(
              new THREE.BoxGeometry(dockW / plankCount * 0.82, 0.04, dockL * 0.96),
                plankMats[i % plankMats.length],
            );
            plank.position.set(
              -dockW * 0.5 + (i + 0.5) * (dockW / plankCount),
              0.25,
              0,
            );
            plank.castShadow = true;
            plank.receiveShadow = true;
            dock.add(plank);
          }

          for (const side of [-1, 1] as const) {
            for (let i = 0; i < 4; i++) {
              const z = -dockL * 0.42 + i * (dockL * 0.28);
              const postHeight = 1.35 + rng(i * 191 + side) * 0.4;
              const post = new THREE.Mesh(
                new THREE.BoxGeometry(0.18, postHeight, 0.18),
                beamMat,
              );
              post.position.set(side * (island.dock.width * 0.45), postHeight * 0.45, z);
              post.castShadow = true;
              dock.add(post);

              if (i < 3) {
                const railLen = Math.max(0.15, dockL * 0.24);
                const rail = new THREE.Mesh(
                  new THREE.CylinderGeometry(0.035, 0.035, railLen, 6),
                  ropeMat,
                );
                rail.rotation.z = Math.PI * 0.5;
                rail.position.set(side * (dockW * 0.44), 0.88, z + dockL * 0.14);
                dock.add(rail);
              }
            }
          }
        }
      } else if (!dockUsesGlb) {
        for (const postSide of [-1, 1] as const) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.25, 0.18), beamMat);
          post.position.set(postSide * (dockW * 0.44), 0.65, dockL * 0.22);
          dock.add(post);
        }
      }

      const bollard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.13, 0.55, 8),
        beamMat,
      );
      bollard.position.set(island.dock.moorSide * dockW * 0.28, 0.26, dockL * 0.18);
      bollard.castShadow = true;
      dock.add(bollard);

      if (!lowDetail) {
        // Lanterns at the dock's shore end. Warm light is routed through the
        // night-budget system (registerLanternEmitter) instead of always-on lamps.
        if (assets.has('lantern_post')) {
          const deckY = dockUsesGlb ? 0.18 : 0.26;
          for (const lanternSide of [-1, 1] as const) {
            const post = this.buildPropInstance(
              'lantern_post',
              new THREE.Vector3(lanternSide * (dockW * 0.46 - 0.12), deckY, -dockL * 0.38),
              // lantern arm points +X in asset space — swing it inward over the walkway
              lanternSide === 1 ? Math.PI : 0,
            );
            if (post) dock.add(post);
            this.registerLanternEmitter(dock, lanternSide * (dockW * 0.46 - 0.12), deckY + 2.1, -dockL * 0.38, 'lantern');
          }
        } else {
          const lanternMat = new THREE.MeshStandardMaterial({
            color: 0x8b6c2a,
            emissive: 0xffcc44,
            emissiveIntensity: 0.5,
            roughness: 0.9,
          });
          for (const lanternSide of [-1, 1] as const) {
            const lanternPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.8, 0.16), beamMat);
            lanternPost.position.set(lanternSide * (dockW * 0.46), 0.9, -dockL * 0.38);
            lanternPost.castShadow = true;
            dock.add(lanternPost);

            const lanternBox = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), lanternMat);
            lanternBox.position.set(lanternSide * (dockW * 0.46), 1.95, -dockL * 0.38);
            dock.add(lanternBox);

            this.registerLanternEmitter(dock, lanternSide * (dockW * 0.46), 1.95, -dockL * 0.38, 'lantern');
          }
        }
      }

      group.add(dock);
    }

    if (island.tavern) {
      const t = island.tavern;
      const tavern = new THREE.Group();
      tavern.position.set(t.position.x - island.position.x, t.position.y, t.position.z - island.position.z);
      tavern.rotation.y = t.rotation;

      const wallMat = new THREE.MeshStandardMaterial({ color: 0x6e4823, roughness: 0.95 });
      const beamMat2 = new THREE.MeshStandardMaterial({ color: 0x2f1d10, roughness: 1 });
      const thatchMat = new THREE.MeshStandardMaterial({ color: 0xa68040, roughness: 1 });
      const floorMat = new THREE.MeshStandardMaterial({ color: 0x553823, roughness: 1 });
      const counterMat = new THREE.MeshStandardMaterial({ color: 0x3f2616, roughness: 0.9 });
      const lanternMat2 = new THREE.MeshStandardMaterial({ color: 0x8b6c2a, emissive: 0xff9c44, emissiveIntensity: 0.65, roughness: 0.9 });
      const signMat = new THREE.MeshStandardMaterial({ color: 0x3a2414, roughness: 1 });

      const wallH = 3.0;
      const w = t.width;
      const d = t.depth;

      const floor = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.18, d + 0.6), floorMat);
      floor.position.y = 0.09;
      floor.receiveShadow = true;
      tavern.add(floor);

      const wallThickness = 0.22;
      const makeWall = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), wallMat);
        wall.position.set(x, y, z);
        wall.castShadow = true;
        wall.receiveShadow = true;
        return wall;
      };

      // Back wall (full)
      tavern.add(makeWall(w, wallH, wallThickness, 0, wallH * 0.5 + 0.18, -d * 0.5));
      // Side walls (full)
      tavern.add(makeWall(wallThickness, wallH, d, -w * 0.5, wallH * 0.5 + 0.18, 0));
      tavern.add(makeWall(wallThickness, wallH, d, w * 0.5, wallH * 0.5 + 0.18, 0));
      // Front wall split with door opening
      const doorWidth = 1.6;
      const sideFrontW = (w - doorWidth) * 0.5;
      tavern.add(makeWall(sideFrontW, wallH, wallThickness, -(w * 0.5 - sideFrontW * 0.5), wallH * 0.5 + 0.18, d * 0.5));
      tavern.add(makeWall(sideFrontW, wallH, wallThickness, w * 0.5 - sideFrontW * 0.5, wallH * 0.5 + 0.18, d * 0.5));
      // Door lintel above the doorway
      tavern.add(makeWall(doorWidth + 0.1, 0.4, wallThickness, 0, wallH + 0.18 - 0.2, d * 0.5));

      // Corner beams
      for (const cx of [-1, 1] as const) {
        for (const cz of [-1, 1] as const) {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.22, wallH + 0.6, 0.22), beamMat2);
          beam.position.set(cx * (w * 0.5 + 0.04), wallH * 0.5 + 0.18, cz * (d * 0.5 + 0.04));
          beam.castShadow = true;
          tavern.add(beam);
        }
      }

      // Steep thatched roof — two slabs forming a gable
      const ridgeY = wallH + 0.18 + 1.4;
      const slope = Math.atan2(1.4, d * 0.5 + 0.18);
      for (const side of [-1, 1] as const) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 1.0, 0.22, Math.hypot(d * 0.5 + 0.18, 1.4) + 0.2), thatchMat);
        slab.position.set(0, (wallH + 0.18 + ridgeY) * 0.5, side * (d * 0.25 + 0.1));
        slab.rotation.x = side * (Math.PI * 0.5 - slope);
        slab.castShadow = true;
        slab.receiveShadow = true;
        tavern.add(slab);
      }
      // Ridge beam
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(w + 1.0, 0.16, 0.2), beamMat2);
      ridge.position.set(0, ridgeY, 0);
      ridge.castShadow = true;
      tavern.add(ridge);
      // Gable triangles (filled with wall planks visually)
      for (const side of [-1, 1] as const) {
        const gable = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 1.4, 0.18), wallMat);
        gable.position.set(0, wallH + 0.18 + 0.7, side * (d * 0.5));
        tavern.add(gable);
      }

      if (!lowDetail) {
        // Bar counter inside the tavern, set back from the door
        const counter = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 1.0, 0.7), counterMat);
        counter.position.set(0, 0.6, -d * 0.18);
        counter.castShadow = true;
        counter.receiveShadow = true;
        tavern.add(counter);
        // Counter top accent
        const counterTop = new THREE.Mesh(new THREE.BoxGeometry(w * 0.74, 0.06, 0.78), beamMat2);
        counterTop.position.set(0, 1.13, -d * 0.18);
        tavern.add(counterTop);

        // Stools at the bar
        for (let s = -1; s <= 1; s++) {
          const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.7, 8), counterMat);
          stool.position.set(s * 1.3, 0.35, -d * 0.18 + 0.85);
          stool.castShadow = true;
          tavern.add(stool);
        }

        // Tables
        for (const tableSide of [-1, 1] as const) {
          const tableGroup = new THREE.Group();
          tableGroup.position.set(tableSide * (w * 0.32), 0, d * 0.12);
          const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.2), counterMat);
          top.position.y = 0.78;
          top.castShadow = true;
          tableGroup.add(top);
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.78, 6), beamMat2);
          leg.position.y = 0.39;
          tableGroup.add(leg);
          tavern.add(tableGroup);
        }

        // Hanging lanterns under roof (warm light via the night-budget system).
        for (const lx of [-1.4, 1.4, 0] as const) {
          const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.34, 0.28), lanternMat2);
          lantern.position.set(lx, wallH - 0.3, 0);
          tavern.add(lantern);
          if (lx === 0) {
            this.registerLanternEmitter(tavern, 0, wallH - 0.4, 0, 'lantern');
          }
        }
      }

      // Hanging signpost above the door
      const signPost = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 0.14), beamMat2);
      signPost.position.set(0, wallH + 0.6, d * 0.5 + 0.55);
      tavern.add(signPost);
      const signPlank = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.08), signMat);
      signPlank.position.set(0, wallH + 0.2, d * 0.5 + 0.55);
      tavern.add(signPlank);
      if (!lowDetail) {
        const tankardSign = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.16, 0.32, 10),
          new THREE.MeshStandardMaterial({ color: 0xc89b3a, roughness: 0.55, metalness: 0.5 }),
        );
        tankardSign.position.set(0, wallH + 0.2, d * 0.5 + 0.6);
        tankardSign.rotation.x = Math.PI * 0.5;
        tavern.add(tankardSign);
      }

      // Chimney with a smoke puff (just static)
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.6, 0.7), beamMat2);
      chimney.position.set(w * 0.32, wallH + 0.9, -d * 0.32);
      chimney.castShadow = true;
      tavern.add(chimney);

      group.add(tavern);
    }

    // Walkable caves — terrain hollows out via getIslandSurfaceY, this block adds the
    // ceiling, side walls, back wall, entrance frame, and a torch so the cavern reads
    // as a real explorable cave you can step into.
    if (island.caves && island.caves.length > 0) {
      const caveStoneMat = new THREE.MeshStandardMaterial({ color: 0x3a342a, roughness: 1 });
      const caveWallMat = new THREE.MeshStandardMaterial({ color: 0x2a241d, roughness: 1, side: THREE.DoubleSide });
      const caveCeilingMat = new THREE.MeshStandardMaterial({ color: 0x1a1610, roughness: 1, side: THREE.DoubleSide });
      const caveFloorMat = new THREE.MeshStandardMaterial({ color: 0x4a3e2c, roughness: 1 });
      const torchMat = new THREE.MeshStandardMaterial({ color: 0x4a2f17, roughness: 1 });
      const flameMat = new THREE.MeshStandardMaterial({ color: 0xff8a20, emissive: 0xff5500, emissiveIntensity: 1.4, roughness: 0.4 });

      for (const cave of island.caves) {
        const caveGroup = new THREE.Group();
        caveGroup.position.set(cave.position.x - island.position.x, cave.position.y, cave.position.z - island.position.z);
        caveGroup.rotation.y = cave.rotation;

        const cw = cave.width;
        const ch = cave.height;
        const cLen = (cave as { length?: number }).length ?? 10;
        const cR = (cave as { interiorRadius?: number }).interiorRadius ?? 3.0;
        // Cave-local Y where floor sits (heightmap drops here via getIslandSurfaceY)
        const floorLocalY = -0.4;
        const ceilingLocalY = floorLocalY + ch;
        // Cave tunnel runs from local z=0 (entrance) to z=-cLen (back)

        // ── Entrance frame: chunky rim boulders so the opening reads as a cliff hole ──
        const frameSegments = lowDetail ? 5 : 8;
        for (let i = 0; i < frameSegments; i++) {
          const t = i / (frameSegments - 1);
          const angle = Math.PI * (1 - t);
          const fx = Math.cos(angle) * cR * 1.05;
          const fy = floorLocalY + Math.sin(angle) * ch * 0.85 + 0.2;
          const rock = new THREE.Mesh(boulderGeo, caveStoneMat);
          rock.scale.setScalar(0.55 + rng(i * 311 + cw * 3) * 0.5);
          rock.position.set(fx, fy, 0.18);
          rock.rotation.set(rng(i * 313) * Math.PI, rng(i * 317) * Math.PI, rng(i * 319) * Math.PI);
          rock.castShadow = true;
          caveGroup.add(rock);
        }
        for (const side of [-1, 1] as const) {
          const base = new THREE.Mesh(boulderGeo, caveStoneMat);
          base.scale.set(0.9, 0.7, 0.9);
          base.position.set(side * (cR + 0.3), floorLocalY + 0.45, 0.1);
          base.castShadow = true;
          caveGroup.add(base);
        }

        // ── Cave floor: a flat slab inside the tunnel so the surface reads cleanly
        //     even where terrain mesh resolution can't capture the hollow precisely ──
        const floorMesh = new THREE.Mesh(
          new THREE.BoxGeometry(cR * 2, 0.16, cLen),
          caveFloorMat,
        );
        floorMesh.position.set(0, floorLocalY - 0.08, -cLen * 0.5);
        floorMesh.receiveShadow = true;
        caveGroup.add(floorMesh);

        // ── Side walls: rough stone running the length of the tunnel ──
        for (const side of [-1, 1] as const) {
          const wall = new THREE.Mesh(
            new THREE.PlaneGeometry(cLen, ch),
            caveWallMat,
          );
          wall.position.set(side * cR, floorLocalY + ch * 0.5, -cLen * 0.5);
          wall.rotation.y = side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5;
          wall.receiveShadow = true;
          caveGroup.add(wall);
        }

        // ── Ceiling: a slightly arched roof using two angled slabs ──
        const archHalf = cR + 0.2;
        for (const side of [-1, 1] as const) {
          const slab = new THREE.Mesh(
            new THREE.PlaneGeometry(archHalf, cLen),
            caveCeilingMat,
          );
          slab.position.set(side * archHalf * 0.5, ceilingLocalY - 0.08, -cLen * 0.5);
          slab.rotation.x = Math.PI * 0.5;
          slab.rotation.z = side * 0.18;
          slab.receiveShadow = true;
          caveGroup.add(slab);
        }
        // Centre ridge of the ceiling
        const ridge = new THREE.Mesh(
          new THREE.PlaneGeometry(0.6, cLen),
          caveCeilingMat,
        );
        ridge.position.set(0, ceilingLocalY, -cLen * 0.5);
        ridge.rotation.x = Math.PI * 0.5;
        caveGroup.add(ridge);

        // ── Back wall: closes off the tunnel ──
        const back = new THREE.Mesh(
          new THREE.PlaneGeometry(cR * 2, ch),
          caveWallMat,
        );
        back.position.set(0, floorLocalY + ch * 0.5, -cLen);
        back.rotation.y = 0; // facing +Z, visible from inside
        caveGroup.add(back);

        // ── Stalactite + stalagmite accents ──
        const stoneAccentMat = new THREE.MeshStandardMaterial({ color: 0x4a3e2e, roughness: 1, flatShading: true });
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
        if (!lowDetail) {
          // Warm cave torch light via the night-budget system (glow sprite by day).
          this.registerLanternEmitter(caveGroup, flame.position.x, flame.position.y, flame.position.z, 'lantern');
        }

        // ── Treasure chest tucked at the back of the cave (visual only — gameplay
        //     chests still spawn from server). A subtle gold glint that draws explorers in. ──
        if (rng(cw * 11) > 0.5 && !lowDetail) {
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

    // (Client-only boulder/palm scatter removed: palms and boulders now come
    // from the server prop registry via buildServerProps — visuals match the
    // colliders players actually hit. Micro-decor below has no colliders.)

    const outcropCount = scaledCount(Math.round(r / 18), 2);
    for (let i = 0; i < outcropCount; i++) {
      const angle = islandHeading + i * ((Math.PI * 2) / outcropCount) + rng(i * 43) * 0.55;
      const distRatio = 0.62 + rng(i * 47) * 0.14;
      const ocH = Math.max(0.12, 0.85 + rng(i * 61) * 0.9);
      const outcropSample = surfacePoint(distRatio, angle, ocH * 0.22);
      if (!isSolidDecorPoint(outcropSample)) continue; // archipelago saddle — skip
      const outcrop = new THREE.Mesh(
        new THREE.CylinderGeometry(
          Math.max(0.06, 0.18 + rng(i * 53) * 0.2),
          Math.max(0.06, 0.34 + rng(i * 59) * 0.22),
          ocH,
          6,
        ),
        cliffMat,
      );
      outcrop.position.copy(outcropSample);
      outcrop.rotation.set(rng(i * 67) * 0.2, rng(i * 71) * Math.PI * 2, (rng(i * 73) - 0.5) * 0.28);
      outcrop.scale.setScalar(0.9 + rng(i * 79) * 0.6);
      outcrop.castShadow = true;
      outcrop.receiveShadow = true;
      group.add(outcrop);
    }

    const driftwoodCount = lowDetail ? 0 : 3 + Math.floor(rng(islandSeed) * 3);
    for (let i = 0; i < driftwoodCount; i++) {
      const angle = rng(i * 223 + 7) * Math.PI * 2;
      const distRatio = 0.76 + rng(i * 229) * 0.16;
      const logPos = surfacePoint(distRatio, angle, 0.04);
      if (!isSolidDecorPoint(logPos, SURFACE_ABOVE_WATER, -0.2)) continue;
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
    if (!lowDetail && r > 52) {
      const bambooClusters = 1 + Math.floor(rng(islandSeed * 3 + 1) * 2);
      for (let g = 0; g < bambooClusters; g++) {
        const clusterAngle = rng(g * 251) * Math.PI * 2;
        const clusterDist = 0.12 + rng(g * 257) * 0.22;
        const clusterCenter = surfacePoint(clusterDist, clusterAngle);
        if (!isSolidDecorPoint(clusterCenter)) continue;
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

    if (!lowDetail && r > 38) {
      const wreckAngle = islandHeading + Math.PI * (0.55 + rng(islandSeed * 7) * 0.5);
      const wreckPos = surfacePoint(0.82 + rng(islandSeed * 11) * 0.08, wreckAngle, 0.0);
      const wreckSolid = isSolidDecorPoint(wreckPos, SURFACE_ABOVE_WATER, -0.15);
      const wreckGlb = wreckSolid
        ? this.buildPropInstance(
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
        group.add(wreckGlb);
      } else if (false as boolean) { // procedural wreck fallback retired — GLB or nothing
        const wreck = new THREE.Group();
        wreck.position.copy(wreckPos);
        wreck.rotation.y = -wreckAngle + Math.PI * 0.5;
        // Heel the whole wreck slightly to one side so it lies plausibly on the beach
        wreck.rotation.z = (rng(islandSeed * 19) - 0.5) * 0.45;

      const keel = new THREE.Mesh(new THREE.BoxGeometry(r * 0.14, 0.18, 0.5 + r * 0.03), wreckMat);
      keel.position.y = 0.12;
      keel.castShadow = true;
      keel.receiveShadow = true;
      wreck.add(keel);

      const ribCount = 7;
      for (let rib = 0; rib < ribCount; rib++) {
        const z = -r * 0.07 + rib * (r * 0.025);
        for (const sx of [-1, 1] as const) {
          const broken = rng(rib * 307 + (sx > 0 ? 1 : 0)) > 0.65;
          const ribH = (broken ? 0.4 : 1.2) + rng(rib * 311) * 0.7;
          const frame = new THREE.Mesh(
            new THREE.BoxGeometry(0.11, ribH, 0.12),
            wreckMat,
          );
          frame.position.set(sx * (0.36 + rib * 0.055), 0.18 + ribH * 0.5, z);
          frame.rotation.z = sx * (0.58 + rib * 0.035 + (broken ? 0.4 : 0));
          frame.castShadow = true;
          wreck.add(frame);
        }
      }

      // Hull planks attached to outer ribs (only some — rotting away)
      const plankSpan = r * 0.13;
      for (let p = 0; p < 8; p++) {
        if (rng(p * 313 + islandSeed) > 0.55) continue;
        const sx = rng(p * 317) > 0.5 ? 1 : -1;
        const plank = new THREE.Mesh(
          new THREE.BoxGeometry(0.07, 0.42 + rng(p * 319) * 0.4, plankSpan + rng(p * 323) * 0.4),
          wreckMat,
        );
        plank.position.set(sx * (0.5 + rng(p * 331) * 0.18), 0.32 + rng(p * 337) * 0.35, -r * 0.04 + p * 0.16);
        plank.rotation.z = sx * (0.62 + rng(p * 343) * 0.18);
        plank.rotation.y = (rng(p * 347) - 0.5) * 0.1;
        plank.castShadow = true;
        wreck.add(plank);
      }

      // Loose planks scattered around the wreck (surface-attached, not floating)
      for (let plank = 0; plank < 8; plank++) {
        const loose = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.08, 1.1 + rng(plank * 311) * 0.9),
          wreckMat,
        );
        const lx = (rng(plank * 313) - 0.5) * 3.2;
        const lz = (rng(plank * 317) - 0.5) * 3.0;
        const lWorldX = wreckPos.x + island.position.x + lx;
        const lWorldZ = wreckPos.z + island.position.z + lz;
        const lSurfY = getIslandSurfaceY(island, lWorldX, lWorldZ);
        loose.position.set(lx, lSurfY - wreckPos.y + 0.06, lz);
        loose.rotation.set(0.04, rng(plank * 331) * Math.PI * 2, (rng(plank * 337) - 0.5) * 0.22);
        loose.castShadow = true;
        wreck.add(loose);
      }

      // Snapped mast lying alongside the keel
      const mastLen = r * 0.18 + 1.8;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, mastLen, 7), wreckMat);
      mast.rotation.x = Math.PI * 0.5;
      mast.rotation.z = 0.18;
      mast.position.set(-0.55, 0.32, -r * 0.02);
      mast.castShadow = true;
      wreck.add(mast);

      // Mast stump still standing
      const stumpH = 1.2 + rng(islandSeed * 23) * 1.0;
      const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, stumpH, 7), wreckMat);
      stump.position.set(0.05, 0.18 + stumpH * 0.5, r * 0.0);
      stump.rotation.z = 0.08;
      stump.castShadow = true;
      wreck.add(stump);

      // Tattered sail draped over the stump
      const tornSail = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4, 2, 2), canvasMat);
      tornSail.position.set(-0.55, 0.7, -0.55);
      tornSail.rotation.set(-0.45, 0.2, -0.18);
      tornSail.castShadow = false;
      wreck.add(tornSail);

      // Half-buried barrel & ruptured cargo
      const barrelMat2 = new THREE.MeshStandardMaterial({ color: 0x4a3217, roughness: 1 });
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.7, 12), barrelMat2);
      const bx = 1.2 + rng(islandSeed * 29) * 0.6;
      const bz = -0.6 + rng(islandSeed * 31) * 0.5;
      const bSurfY = getIslandSurfaceY(island, wreckPos.x + island.position.x + bx, wreckPos.z + island.position.z + bz);
      barrel.rotation.z = Math.PI * 0.5;
      barrel.position.set(bx, bSurfY - wreckPos.y + 0.34, bz);
      barrel.castShadow = true;
      wreck.add(barrel);
      // Iron bands
      for (let band = -1; band <= 1; band++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.36, 0.03, 6, 14),
          new THREE.MeshStandardMaterial({ color: 0x2a221a, roughness: 1 }),
        );
        ring.position.set(bx + band * 0.18, bSurfY - wreckPos.y + 0.34, bz);
        ring.rotation.y = Math.PI * 0.5;
        wreck.add(ring);
      }

      // Anchor in the sand
      const anchorMat = new THREE.MeshStandardMaterial({ color: 0x222018, roughness: 0.95, metalness: 0.4 });
      const ax = -1.6 + rng(islandSeed * 37) * 0.4;
      const az = 1.0 + rng(islandSeed * 41) * 0.5;
      const aSurfY = getIslandSurfaceY(island, wreckPos.x + island.position.x + ax, wreckPos.z + island.position.z + az);
      const anchorShank = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.4, 6), anchorMat);
      anchorShank.position.set(ax, aSurfY - wreckPos.y + 0.18, az);
      anchorShank.rotation.x = Math.PI * 0.5;
      anchorShank.rotation.z = 0.45;
      anchorShank.castShadow = true;
      wreck.add(anchorShank);
      const anchorArm = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.07, 6, 12, Math.PI), anchorMat);
      anchorArm.position.set(ax + 0.4, aSurfY - wreckPos.y + 0.16, az);
      anchorArm.rotation.set(Math.PI * 0.5, 0.25, 0);
      wreck.add(anchorArm);

      // Trailing rope from anchor to wreck stump (just a poly-line)
      const ropeGeo = new THREE.BufferGeometry();
      ropeGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        ax, aSurfY - wreckPos.y + 0.36, az,
        ax * 0.4, 0.6, az * 0.4,
        0.05, 0.55, 0.0,
      ], 3));
      const rope = new THREE.Line(ropeGeo, new THREE.LineBasicMaterial({ color: 0xa68f5a }));
      wreck.add(rope);

        group.add(wreck);
      }
    }

    // ── Beach detail: shells, starfish, seaweed clumps, tide pools, washed-up jellyfish ──
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
          const pool = new THREE.Mesh(
            new THREE.CircleGeometry(0.7 + rng(i * 681) * 0.6, 14),
            tidePoolMat,
          );
          pool.rotation.x = -Math.PI * 0.5;
          pool.position.copy(pos);
          pool.position.y += 0.02;
          group.add(pool);
          // Encircling rocks
          for (let r2 = 0; r2 < 5; r2++) {
            const ra = (r2 / 5) * Math.PI * 2;
            const rock = new THREE.Mesh(boulderGeo, boulderMat);
            rock.scale.setScalar(0.16 + rng(r2 * 683 + i) * 0.18);
            rock.position.copy(pos);
            rock.position.x += Math.cos(ra) * (0.85 + rng(r2 * 687 + i) * 0.3);
            rock.position.z += Math.sin(ra) * (0.85 + rng(r2 * 689 + i) * 0.3);
            rock.position.y += 0.08;
            rock.rotation.set(rng(r2 * 691) * Math.PI, rng(r2 * 693) * Math.PI, rng(r2 * 697) * Math.PI);
            group.add(rock);
          }
        }
      }
    }

    // ── Snow cap on tall mountain peaks ──
    if (island.profile.terrainStyle === 'mountain' && (island.profile.peakBoost ?? 0) > 0.65) {
      const snowMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.65, emissive: 0x8aa4c4, emissiveIntensity: 0.04 });
      const peakAngle = island.profile.primaryHillAngle;
      const peakOffset = island.profile.primaryHillOffset;
      const px = Math.cos(peakAngle) * peakOffset * island.profile.footprintX;
      const pz = Math.sin(peakAngle) * peakOffset * island.profile.footprintZ;
      const peakWorldX = px + island.position.x;
      const peakWorldZ = pz + island.position.z;
      const peakY = getIslandSurfaceY(island, peakWorldX, peakWorldZ);
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(2.6 + island.profile.peakBoost * 1.4, 1.4 + island.profile.peakBoost * 1.6, 9, 1),
        snowMat,
      );
      cap.position.set(px, peakY + 0.6, pz);
      cap.castShadow = true;
      cap.receiveShadow = true;
      group.add(cap);
      // Snow patches around the peak — flat circles laid on the surface
      const snowPatchMat = new THREE.MeshStandardMaterial({ color: 0xeaf1f8, roughness: 0.85, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
      for (let s = 0; s < 8; s++) {
        const sa = (s / 8) * Math.PI * 2 + rng(s * 701) * 0.4;
        const sd = 1.2 + rng(s * 703) * 1.6;
        const sx = px + Math.cos(sa) * sd;
        const sz = pz + Math.sin(sa) * sd;
        const sWorldY = getIslandSurfaceY(island, sx + island.position.x, sz + island.position.z);
        if (sWorldY < peakY - 4) continue; // only near the summit
        const patch = new THREE.Mesh(
          new THREE.CircleGeometry(0.6 + rng(s * 707) * 0.7, 10),
          snowPatchMat,
        );
        patch.rotation.x = -Math.PI * 0.5;
        patch.position.set(sx, sWorldY + 0.05, sz);
        group.add(patch);
      }
    }

    // ── Waterfalls — every tall island earns cascades (SoT reference: white
    // ribbons pouring off the rock with mist at the base). Mountains get two
    // falls on opposite shoulders; tall plateaus one.
    const fallCount = island.profile.terrainStyle === 'mountain' ? 2
      : (island.profile.terrainStyle === 'plateau' || island.profile.terrainStyle === 'twin') ? 1
        : 0;
    for (let fall = 0; fall < fallCount; fall++) {
      const fallAngle = island.profile.ridgeAxis
        + Math.PI * (fall === 0 ? 0.5 : -0.55)
        + (rng(islandSeed * 47 + fall * 131) - 0.5) * 0.4;
      const upper = surfacePoint(0.3, fallAngle);
      const lower = surfacePoint(0.94, fallAngle);
      const drop = upper.y - lower.y;
      if (drop > 4) {
        const fallMat = new THREE.MeshStandardMaterial({
          color: 0xc7e6f4,
          emissive: 0xb8e0f5,
          emissiveIntensity: 0.32,
          roughness: 0.4,
          transparent: true,
          opacity: 0.78,
          side: THREE.DoubleSide,
        });
        // Vertical ribbons drawn with explicit corner geometry — guarantees the
        // ribbons hang directly between the upper sample and the lower sample.
        const ribbons = lowDetail ? 2 : 4;
        const dxFall = lower.x - upper.x;
        const dzFall = lower.z - upper.z;
        const horizFall = Math.hypot(dxFall, dzFall);
        const wAxisX = horizFall > 0.001 ? -dzFall / horizFall : 1;
        const wAxisZ = horizFall > 0.001 ? dxFall / horizFall : 0;
        for (let rib = 0; rib < ribbons; rib++) {
          const t = rib / Math.max(1, ribbons - 1);
          const offset = (t - 0.5) * 1.0;
          const ax = upper.x + wAxisX * offset;
          const az = upper.z + wAxisZ * offset;
          const bx = lower.x + wAxisX * offset;
          const bz = lower.z + wAxisZ * offset;
          const ribbonW = 1.25 + rng(rib * 711) * 0.9;
          const corners = [
            ax + wAxisX * ribbonW * 0.5, upper.y, az + wAxisZ * ribbonW * 0.5,
            ax - wAxisX * ribbonW * 0.5, upper.y, az - wAxisZ * ribbonW * 0.5,
            bx + wAxisX * ribbonW * 0.5, lower.y, bz + wAxisZ * ribbonW * 0.5,
            bx - wAxisX * ribbonW * 0.5, lower.y, bz - wAxisZ * ribbonW * 0.5,
          ];
          const ribbonGeo = new THREE.BufferGeometry();
          ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
          ribbonGeo.setIndex([0, 2, 1, 1, 2, 3]);
          ribbonGeo.computeVertexNormals();
          const ribbon = new THREE.Mesh(ribbonGeo, fallMat);
          ribbon.position.set(0, 0, 0);
          group.add(ribbon);
        }
        // Foam pool at the base
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(2.0, 18),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
        );
        pool.rotation.x = -Math.PI * 0.5;
        pool.position.set(lower.x, lower.y + 0.05, lower.z);
        group.add(pool);
        // Mist particles (simple white spheres with low opacity)
        if (!lowDetail) {
          for (let m = 0; m < 5; m++) {
            const mist = new THREE.Mesh(
              new THREE.SphereGeometry(0.6 + rng(m * 713) * 0.4, 6, 4),
              new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 }),
            );
            mist.position.set(
              lower.x + (rng(m * 717) - 0.5) * 1.4,
              lower.y + 0.4 + rng(m * 721) * 1.2,
              lower.z + (rng(m * 723) - 0.5) * 1.4,
            );
            group.add(mist);
          }
        }
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

    // ── Layered cliff strata — exposed rock bands wrapping high cliffs ──
    // (skipped on mountains: the sheer spires changed the slopes those slabs
    // were sampled against, leaving them floating mid-air)
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

    // (Procedural stone arch removed — rock_arch is a real Blender GLB
    // placed by the server prop registry now.)


    // ── Lookout post — wooden tower on or near a high point ──
    if (!lowDetail && r > 40) {
      const lookout = new THREE.Group();
      const angle = island.profile.primaryHillAngle + (rng(islandSeed * 83) - 0.5) * 0.6;
      const distRatio = 0.18 + rng(islandSeed * 89) * 0.18;
      const base = surfacePoint(distRatio, angle, 0);
      lookout.position.set(base.x, base.y, base.z);
      const towerYaw = rng(islandSeed * 97) * Math.PI * 2;
      lookout.rotation.y = towerYaw;
      const towerMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 });
      const beamMat = new THREE.MeshStandardMaterial({ color: 0x2d1d0e, roughness: 1 });
      const towerH = 4.2 + rng(islandSeed * 101) * 1.6;
      // Find the highest leg base so we know how to extend the others
      const legOffset = 0.7;
      const legPositions: { sx: number; sz: number; surfaceY: number }[] = [];
      const cosY = Math.cos(towerYaw);
      const sinY = Math.sin(towerYaw);
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          // Local (sx*0.7, sz*0.7) in lookout space → world position
          const wx = base.x + island.position.x + (sx * legOffset * cosY + sz * legOffset * sinY);
          const wz = base.z + island.position.z + (-sx * legOffset * sinY + sz * legOffset * cosY);
          const wy = getIslandSurfaceY(island, wx, wz);
          legPositions.push({ sx, sz, surfaceY: wy });
        }
      }
      const minSurface = Math.min(...legPositions.map((p) => p.surfaceY));
      const platformY = Math.max(...legPositions.map((p) => p.surfaceY)) + towerH;
      // Anchor lookout group at the lowest leg base so all positions are >= 0 in local
      lookout.position.y = minSurface;
      // Legs extend from each ground point up to the platform
      for (const { sx, sz, surfaceY } of legPositions) {
        const localBaseY = surfaceY - minSurface;
        const localTopY = platformY - minSurface;
        const legH = localTopY - localBaseY;
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, legH, 0.18), towerMat);
        leg.position.set(sx * legOffset, localBaseY + legH * 0.5, sz * legOffset);
        leg.castShadow = true;
        lookout.add(leg);
      }
      const platformLocalY = platformY - minSurface;
      // Cross braces
      for (const sz of [-1, 1] as const) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.1), beamMat);
        brace.position.set(0, platformLocalY * 0.5, sz * 0.7);
        brace.rotation.z = sz * 0.6;
        lookout.add(brace);
      }
      // Platform
      const deck = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 2.0), towerMat);
      deck.position.y = platformLocalY;
      deck.castShadow = true;
      deck.receiveShadow = true;
      lookout.add(deck);
      // Railings
      for (const sx of [-1, 1] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 2.0), beamMat);
        rail.position.set(sx * 0.94, platformLocalY + 0.55, 0);
        lookout.add(rail);
      }
      for (const sz of [-1, 1] as const) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, 0.08), beamMat);
        rail.position.set(0, platformLocalY + 0.55, sz * 0.94);
        lookout.add(rail);
      }
      // Flag
      const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 5), beamMat);
      flagPole.position.set(0.6, platformLocalY + 1.25, 0.6);
      lookout.add(flagPole);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.0, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x6e1313, roughness: 0.95, side: THREE.DoubleSide }),
      );
      flag.position.set(1.1, platformLocalY + 2.1, 0.6);
      lookout.add(flag);
      // Ladder up the front (anchored at the front-corner leg's base)
      const frontLeg = legPositions.find((p) => p.sz === 1) ?? legPositions[0];
      const ladderBase = frontLeg.surfaceY - minSurface;
      const ladderTop = platformLocalY;
      const rungCount = Math.max(6, Math.floor((ladderTop - ladderBase) / 0.45));
      for (let rung = 0; rung < rungCount; rung++) {
        const ry = ladderBase + 0.2 + rung * (ladderTop - ladderBase - 0.4) / Math.max(1, rungCount - 1);
        const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.06), towerMat);
        r2.position.set(0, ry, 0.92);
        lookout.add(r2);
      }
      void towerH;
      if (isSolidDecorPoint(base, SURFACE_ABOVE_WATER, -0.2)) group.add(lookout);
    }

    // ── Pirate camp — fire pit, bedrolls, totem, hung skull ──
    if (!lowDetail && r > 38) {
      const camp = new THREE.Group();
      const angle = island.profile.secondaryHillAngle + (rng(islandSeed * 113) - 0.5) * 0.8;
      const distRatio = 0.28 + rng(islandSeed * 127) * 0.24;
      const base = surfacePoint(distRatio, angle, 0);
      const campYaw = rng(islandSeed * 131) * Math.PI * 2;
      camp.position.copy(base);
      camp.rotation.y = campYaw;
      const cosCY = Math.cos(campYaw);
      const sinCY = Math.sin(campYaw);
      const groundOffsetAt = (lx: number, lz: number) => {
        // Convert local camp coords back to world to sample terrain Y
        const wx = base.x + island.position.x + (lx * cosCY + lz * sinCY);
        const wz = base.z + island.position.z + (-lx * sinCY + lz * cosCY);
        return getIslandSurfaceY(island, wx, wz) - base.y;
      };
      const stoneMatC = new THREE.MeshStandardMaterial({ color: 0x3d352b, roughness: 1 });
      const charredMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 1, emissive: 0x6b2a06, emissiveIntensity: 0.4 });
      const logMatC = new THREE.MeshStandardMaterial({ color: 0x2a1a0c, roughness: 1 });
      // Fire pit: GLB stone ring + charred logs when available (interim — a
      // later pass moves camp placement to the server prop registry).
      const campfireGlb = this.buildPropInstance(
        'campfire',
        new THREE.Vector3(0, 0.02, 0),
        rng(islandSeed * 151) * Math.PI * 2,
        1.15,
      );
      if (campfireGlb) {
        camp.add(campfireGlb);
      } else {
        // Fire ring
        for (let s = 0; s < 8; s++) {
          const a = (s / 8) * Math.PI * 2;
          const stone = new THREE.Mesh(boulderGeo, stoneMatC);
          stone.position.set(Math.cos(a) * 0.8, 0.18, Math.sin(a) * 0.8);
          stone.scale.setScalar(0.22 + rng(s * 137) * 0.15);
          stone.rotation.set(rng(s * 139) * Math.PI, rng(s * 143) * Math.PI, rng(s * 149) * Math.PI);
          camp.add(stone);
        }
        // Logs criss-crossed
        for (let l = 0; l < 4; l++) {
          const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.2, 5), logMatC);
          log.rotation.z = Math.PI * 0.5;
          log.rotation.y = (l / 4) * Math.PI;
          log.position.set(0, 0.18, 0);
          camp.add(log);
        }
      }
      // Glowing embers (the in-engine "flame" over the GLB fire pit)
      const embers = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), charredMat);
      embers.position.y = 0.22;
      camp.add(embers);
      // Campfire light + flame sprite via the night-budget system (keeps a small
      // day-time flame; a strong flickering PointLight lights it at night).
      this.registerLanternEmitter(camp, 0, 0.42, 0, 'campfire');

      // Bedrolls
      const bedMat = new THREE.MeshStandardMaterial({ color: 0x6b3823, roughness: 0.95 });
      for (let b = 0; b < 2; b++) {
        const bedAngle = b === 0 ? 1.3 : -1.3;
        const bedLx = Math.cos(bedAngle) * 1.7;
        const bedLz = Math.sin(bedAngle) * 1.7;
        const bedY = groundOffsetAt(bedLx, bedLz);
        const bed = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.22, 0.6), bedMat);
        bed.position.set(bedLx, bedY + 0.12, bedLz);
        bed.rotation.y = -bedAngle + Math.PI * 0.5;
        bed.castShadow = true;
        camp.add(bed);
        const pillowLx = Math.cos(bedAngle) * 2.2;
        const pillowLz = Math.sin(bedAngle) * 2.2;
        const pillowY = groundOffsetAt(pillowLx, pillowLz);
        const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: 0x2a1a14, roughness: 1 }));
        pillow.position.set(pillowLx, pillowY + 0.18, pillowLz);
        pillow.rotation.y = -bedAngle + Math.PI * 0.5;
        camp.add(pillow);
      }
      // Totem with skull — ground its base
      const totemY = groundOffsetAt(-2.2, 0.6);
      const totem = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.4, 6), logMatC);
      totem.position.set(-2.2, totemY + 1.2, 0.6);
      totem.castShadow = true;
      camp.add(totem);
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe8dec2, roughness: 0.85 }));
      skull.position.set(-2.2, totemY + 2.55, 0.6);
      camp.add(skull);
      // Two black eyes
      for (const sx of [-1, 1] as const) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        eye.position.set(-2.2 + sx * 0.07, totemY + 2.58, 0.78);
        camp.add(eye);
      }
      // Cookpot — sits on the ground next to fire
      const potY = groundOffsetAt(1.4, 0.4);
      const potMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, metalness: 0.4 });
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.5, 10), potMat);
      pot.position.set(1.4, potY + 0.34, 0.4);
      pot.castShadow = true;
      camp.add(pot);
      // Tripod over fire
      for (let t = 0; t < 3; t++) {
        const a = (t / 3) * Math.PI * 2;
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.6, 4), logMatC);
        stick.position.set(Math.cos(a) * 0.8, 0.8, Math.sin(a) * 0.8);
        stick.rotation.x = Math.cos(a) * 0.5;
        stick.rotation.z = Math.sin(a) * 0.5;
        camp.add(stick);
      }
      if (isSolidDecorPoint(base, SURFACE_ABOVE_WATER, -0.2)) group.add(camp);
    }

    // ── Rock cairns scattered along higher ground ──
    if (!lowDetail) {
      const cairnCount = scaledCount(2 + Math.round(r / 50), 1);
      for (let i = 0; i < cairnCount; i++) {
        const angle = rng(i * 311 + 17) * Math.PI * 2;
        const distRatio = 0.3 + rng(i * 313 + 19) * 0.3;
        const base = surfacePoint(distRatio, angle, 0);
        if (base.y < 5.6 || !isSolidDecorPoint(base, 5.6, -0.2)) continue;
        const cairn = new THREE.Group();
        cairn.position.copy(base);
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

    // ── Banana trees — short fat-trunked palms with hanging fruit ──
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
        tree.position.copy(pos);
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
        tree.position.copy(pos);
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
      log.position.copy(pos);
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
      if (isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.2)) group.add(log);
    }

    // ── Beached dinghy — small wrecked rowboat in the dunes ──
    if (!lowDetail && r > 40) {
      const dinghyAngle = islandHeading + Math.PI * (rng(islandSeed * 217) > 0.5 ? 0.4 : -0.4);
      const pos = surfacePoint(0.86 + rng(islandSeed * 223) * 0.06, dinghyAngle, 0);
      const dinghy = new THREE.Group();
      dinghy.position.copy(pos);
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
      if (isSolidDecorPoint(pos, SURFACE_ABOVE_WATER, -0.15)) group.add(dinghy);
    }

    // ── Crab traps & fishing nets near the dock ──
    if (island.dock && !lowDetail) {
      const dock = island.dock;
      const ropeMatN = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
      const trapMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 });
      const netMat = new THREE.MeshStandardMaterial({ color: 0xb39c6a, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
      // Hanging fishing net on a frame next to the dock
      const netSideAngle = dock.shoreAngle + dock.moorSide * 0.95;
      const netPos = surfacePoint(0.86, netSideAngle, 0);
      const netGroup = new THREE.Group();
      netGroup.position.copy(netPos);
      // Net frame faces inland so the net spreads toward the dock approach
      netGroup.rotation.y = Math.atan2(-netPos.x, -netPos.z);
      // Frame: two posts + cross bar
      for (const sx of [-1, 1] as const) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 5), trapMat);
        post.position.set(sx * 0.9, 1.1, 0);
        post.castShadow = true;
        netGroup.add(post);
      }
      const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.9, 5), trapMat);
      cross.rotation.z = Math.PI * 0.5;
      cross.position.set(0, 2.0, 0);
      netGroup.add(cross);
      // Net plane
      const net = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.6, 4, 4), netMat);
      net.position.set(0, 1.15, 0.04);
      netGroup.add(net);
      // Drying fish hung on the cross bar
      const fishMat = new THREE.MeshStandardMaterial({ color: 0xb6a37a, roughness: 0.9 });
      for (let f = 0; f < 3; f++) {
        const fish = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.36, 6), fishMat);
        fish.rotation.z = Math.PI * 0.5;
        fish.position.set(-0.6 + f * 0.6, 1.78, 0);
        netGroup.add(fish);
      }
      if (isSolidDecorPoint(netPos, SURFACE_ABOVE_WATER, -0.15)) group.add(netGroup);

      // Crab traps: 2-3 stacked baskets near the shore
      const trapAngle = dock.shoreAngle - dock.moorSide * 0.7;
      const trapBase = surfacePoint(0.84, trapAngle, 0);
      for (let t = 0; t < 3; t++) {
        if (!isSolidDecorPoint(trapBase, SURFACE_ABOVE_WATER, -0.15)) continue;
        const offX = (rng(t * 901 + islandSeed) - 0.5) * 1.2;
        const offZ = (rng(t * 907 + islandSeed) - 0.5) * 1.2;
        const trapWX = trapBase.x + island.position.x + offX;
        const trapWZ = trapBase.z + island.position.z + offZ;
        const trapY = getIslandSurfaceY(island, trapWX, trapWZ);
        const trap = new THREE.Group();
        trap.position.set(trapBase.x + offX, trapY, trapBase.z + offZ);
        trap.rotation.y = rng(t * 911 + islandSeed) * Math.PI * 2;
        // Cube-cage of 4 vertical posts and 3 horizontal bands
        for (const sx of [-1, 1] as const) {
          for (const sz of [-1, 1] as const) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 4), trapMat);
            post.position.set(sx * 0.22, 0.25, sz * 0.22);
            trap.add(post);
          }
        }
        for (let band = 0; band < 3; band++) {
          for (const ax of ['x', 'z'] as const) {
            const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.46, 4), ropeMatN);
            bar.rotation.z = ax === 'x' ? 0 : Math.PI * 0.5;
            bar.rotation.x = ax === 'z' ? 0 : Math.PI * 0.5;
            bar.position.set(ax === 'x' ? 0 : 0.22, 0.08 + band * 0.16, ax === 'z' ? 0 : 0.22);
            // Two parallel sides per axis
            const bar2 = bar.clone();
            bar2.position.set(ax === 'x' ? 0 : -0.22, 0.08 + band * 0.16, ax === 'z' ? 0 : -0.22);
            trap.add(bar);
            trap.add(bar2);
          }
        }
        trap.castShadow = true;
        group.add(trap);
      }
    }

    // ── Stone idol cluster — three carved tiki-style faces ──
    if (!lowDetail && r > 50) {
      const idolMat = new THREE.MeshStandardMaterial({ color: 0x4a4338, roughness: 1, flatShading: true });
      const idolEyeMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 1, emissive: 0x6b1a06, emissiveIntensity: 0.3 });
      const idolAngle = island.profile.tertiaryHillAngle + (rng(islandSeed * 311) - 0.5) * 0.6;
      const cluster = new THREE.Group();
      const clusterCenter = surfacePoint(0.34 + rng(islandSeed * 313) * 0.18, idolAngle, 0);
      cluster.position.copy(clusterCenter);
      cluster.rotation.y = idolAngle + Math.PI;
      for (let i = 0; i < 3; i++) {
        const ix = (i - 1) * 1.4;
        const iz = (i - 1) * 0.3 + (rng(i * 317 + islandSeed) - 0.5) * 0.4;
        const groundY = getIslandSurfaceY(island, clusterCenter.x + island.position.x + ix, clusterCenter.z + island.position.z + iz) - clusterCenter.y;
        const idolH = 1.8 + rng(i * 319 + islandSeed) * 0.8;
        // Body block
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, idolH, 0.6), idolMat);
        body.position.set(ix, groundY + idolH * 0.5, iz);
        body.rotation.y = (rng(i * 321 + islandSeed) - 0.5) * 0.3;
        body.castShadow = true;
        body.receiveShadow = true;
        cluster.add(body);
        // Head
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.55), idolMat);
        head.position.set(ix, groundY + idolH + 0.27, iz);
        head.rotation.y = body.rotation.y;
        cluster.add(head);
        // Brow
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.16), idolMat);
        brow.position.set(ix, groundY + idolH + 0.35, iz + 0.22);
        brow.rotation.y = body.rotation.y;
        cluster.add(brow);
        // Eyes
        for (const sx of [-1, 1] as const) {
          const eye = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.05), idolEyeMat);
          eye.position.set(ix + sx * 0.14, groundY + idolH + 0.25, iz + 0.3);
          eye.rotation.y = body.rotation.y;
          cluster.add(eye);
        }
        // Wide mouth
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.04), idolEyeMat);
        mouth.position.set(ix, groundY + idolH + 0.05, iz + 0.3);
        cluster.add(mouth);
      }
      if (isSolidDecorPoint(clusterCenter, SURFACE_ABOVE_WATER, -0.2)) group.add(cluster);
    }

    // ── Hanging vines from the highest cliff & tallest trees ──
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
        vine.position.set(top.x + Math.cos(va) * 0.4, top.y - vineLen * 0.5 + 0.1, top.z + Math.sin(va) * 0.4);
        vine.rotation.y = va + Math.PI * 0.5;
        vine.rotation.z = (rng(i * 957) - 0.5) * 0.18;
        group.add(vine);
        // Leaves along the vine
        for (let l = 0; l < 4; l++) {
          const lt = (l + 0.5) / 4;
          const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.18), vineMat);
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
        stake.position.copy(sp);
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

    // ── Rope cliff ladder dangling from a high terrace down toward the beach ──
    if (!lowDetail && island.profile.heightProfile > 0.32 && rng(islandSeed * 991) > 0.25) {
      const ladderAngle = island.profile.ridgeAxis + Math.PI + (rng(islandSeed * 997) - 0.5) * 0.8;
      const top = surfacePoint(0.4, ladderAngle, 0);
      const bottom = surfacePoint(0.78, ladderAngle, 0);
      const dropY = top.y - bottom.y;
      if (dropY > 2.5 && isSolidDecorPoint(top, SURFACE_ABOVE_WATER, -0.2) && isSolidDecorPoint(bottom, SURFACE_ABOVE_WATER, -0.15)) {
        const dx = bottom.x - top.x;
        const dz = bottom.z - top.z;
        const horiz = Math.hypot(dx, dz);
        if (horiz > 0.5) {
          const len = Math.hypot(horiz, dropY);
          const yaw = Math.atan2(dx, dz);
          // Perpendicular horizontal direction (for ladder width)
          const perpX = Math.cos(yaw); // = dz/horiz
          const perpZ = -Math.sin(yaw); // = -dx/horiz
          const ladderRopeMat = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
          // Two parallel ropes drawn from top → bottom in world coords
          for (const sx of [-1, 1] as const) {
            const ox = perpX * sx * 0.22;
            const oz = perpZ * sx * 0.22;
            const ropePts = [
              top.x + ox, top.y, top.z + oz,
              bottom.x + ox, bottom.y, bottom.z + oz,
            ];
            const ropeGeo = new THREE.BufferGeometry();
            ropeGeo.setAttribute('position', new THREE.Float32BufferAttribute(ropePts, 3));
            const rope = new THREE.Line(ropeGeo, new THREE.LineBasicMaterial({ color: 0xc8b27a, linewidth: 2 }));
            group.add(rope);
          }
          // Rungs spaced along the descent
          const rungCount = Math.max(8, Math.floor(len / 0.45));
          const rungMat2 = new THREE.MeshStandardMaterial({ color: 0x6e4c25, roughness: 0.95 });
          for (let r2 = 0; r2 < rungCount; r2++) {
            const t = (r2 + 0.5) / rungCount;
            const rung = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.05), rungMat2);
            rung.position.set(top.x + dx * t, top.y - dropY * t, top.z + dz * t);
            rung.rotation.y = yaw;
            group.add(rung);
          }
          // Anchor stakes at the top of the cliff
          const anchorStakeMat = new THREE.MeshStandardMaterial({ color: 0x3d2614, roughness: 1 });
          for (const sx of [-1, 1] as const) {
            const ox = perpX * sx * 0.3;
            const oz = perpZ * sx * 0.3;
            const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.6, 5), anchorStakeMat);
            stake.position.set(top.x + ox, top.y + 0.1, top.z + oz);
            stake.castShadow = true;
            group.add(stake);
          }
          // Ladder ropes use Line which uses ladderRopeMat-like color; suppress unused warning
          void ladderRopeMat;
        }
      }
    }

    // ── Secondary smaller wreck on bigger islands so they feel storied ──
    // (skipped when the server registry already placed a shipwreck landmark —
    // two wrecks on one beach reads as a bug, not a story)
    const hasRegistryWreck = (island.props ?? []).some((prop) => prop.type === 'shipwreck');
    if (!lowDetail && r > 64 && island.tavern === null && !hasRegistryWreck) {
      const wAngle = islandHeading + Math.PI * 1.45 + rng(islandSeed * 999) * 0.5;
      const wPos = surfacePoint(0.85 + rng(islandSeed * 1003) * 0.06, wAngle, 0);
      const wreck2Solid = isSolidDecorPoint(wPos, SURFACE_ABOVE_WATER, -0.15);
      const wreck2Glb = wreck2Solid
        ? this.buildPropInstance('shipwreck', wPos, -wAngle + Math.PI * 0.4, 0.5)
        : null;
      if (wreck2Glb) {
        wreck2Glb.rotation.z = (rng(islandSeed * 1009) - 0.5) * 0.24;
        group.add(wreck2Glb);
      } else if (wreck2Solid) {
      const wreck2 = new THREE.Group();
      wreck2.position.copy(wPos);
      wreck2.rotation.y = -wAngle + Math.PI * 0.4;
      wreck2.rotation.z = (rng(islandSeed * 1009) - 0.5) * 0.6;
      // Just a half-buried hull section + scattered planks
      const sectionMat = new THREE.MeshStandardMaterial({ color: 0x4b2f16, roughness: 1 });
      const section = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.2), sectionMat);
      section.position.y = 0.22;
      section.rotation.z = -0.18;
      section.castShadow = true;
      wreck2.add(section);
      for (let p = 0; p < 5; p++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 1.0 + rng(p * 1019 + islandSeed) * 0.6), sectionMat);
        const lx = (rng(p * 1021 + islandSeed) - 0.5) * 2.6;
        const lz = (rng(p * 1023 + islandSeed) - 0.5) * 2.4;
        const lY = getIslandSurfaceY(island, wPos.x + island.position.x + lx, wPos.z + island.position.z + lz) - wPos.y;
        plank.position.set(lx, lY + 0.05, lz);
        plank.rotation.set(0.04, rng(p * 1027 + islandSeed) * Math.PI * 2, (rng(p * 1031 + islandSeed) - 0.5) * 0.3);
        wreck2.add(plank);
      }
      // Loose rib timbers stuck in the sand
      for (let r3 = 0; r3 < 3; r3++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9 + rng(r3 * 1037 + islandSeed) * 0.5, 0.12), sectionMat);
        rib.position.set(0.6 + r3 * 0.4, 0.42, 0.6);
        rib.rotation.z = 0.45 + rng(r3 * 1041) * 0.2;
        wreck2.add(rib);
      }
      group.add(wreck2);
      }
    }

    // ── Trails — packed-dirt paths between dock, tavern, upgrade stations, hoarder, ruins ──
    {
      type WP = { x: number; z: number; kind: 'dock' | 'tavern' | 'npc' | 'upgrade' };
      const waypoints: WP[] = [];
      if (island.dock) waypoints.push({ x: island.dock.respawnPoint.x, z: island.dock.respawnPoint.z, kind: 'dock' });
      if (island.tavern) {
        const t = island.tavern;
        const cosR = Math.cos(t.rotation);
        const sinR = Math.sin(t.rotation);
        waypoints.push({
          x: t.position.x + sinR * (t.depth * 0.5 + 1.6),
          z: t.position.z + cosR * (t.depth * 0.5 + 1.6),
          kind: 'tavern',
        });
      }
      for (const station of island.upgradeStations) waypoints.push({ x: station.position.x, z: station.position.z, kind: 'upgrade' });
      for (const npc of island.npcs) {
        if (npc.role === 'bartender') continue; // bartender is inside the tavern
        waypoints.push({ x: npc.position.x, z: npc.position.z, kind: 'npc' });
      }

      if (waypoints.length >= 2) {
        // Greedy nearest-neighbour ordering anchored at the dock if present.
        const ordered: WP[] = [];
        const remaining = [...waypoints];
        const startIndex = Math.max(0, remaining.findIndex((w) => w.kind === 'dock'));
        ordered.push(remaining.splice(startIndex, 1)[0]);
        while (remaining.length) {
          const last = ordered[ordered.length - 1];
          let bestIndex = 0;
          let bestDist = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const dx = remaining[i].x - last.x;
            const dz = remaining[i].z - last.z;
            const d = dx * dx + dz * dz;
            if (d < bestDist) { bestDist = d; bestIndex = i; }
          }
          ordered.push(remaining.splice(bestIndex, 1)[0]);
        }

        const trailMat = new THREE.MeshStandardMaterial({ color: 0xb09169, roughness: 1 });
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0x6c5e4a, roughness: 1 });
        const trailWidth = 1.6;
        const stepLen = 1.6;

        for (let w = 0; w < ordered.length - 1; w++) {
          const a = ordered[w];
          const b = ordered[w + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 1.5 || dist > island.radius * 1.6) continue;
          const steps = Math.max(2, Math.floor(dist / stepLen));
          const yaw = Math.atan2(dx, dz);
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            // Slight serpentine to feel hand-walked, not surveyed.
            const wiggleAmp = Math.min(1.2, dist * 0.04);
            const offset = Math.sin(t * Math.PI * 2 + w * 1.7) * wiggleAmp * (1 - Math.abs(t - 0.5) * 1.4);
            const px = a.x + dx * t + Math.cos(yaw) * offset;
            const pz = a.z + dz * t - Math.sin(yaw) * offset;
            const py = getIslandSurfaceY(island, px, pz);
            if (py < 5.4) continue;
            const seg = new THREE.Mesh(new THREE.BoxGeometry(trailWidth + (rng(s * 17 + w * 13) - 0.5) * 0.3, 0.08, stepLen + 0.05), trailMat);
            seg.position.set(px - island.position.x, py + 0.05, pz - island.position.z);
            seg.rotation.y = yaw + (rng(s * 19 + w * 23) - 0.5) * 0.06;
            seg.receiveShadow = true;
            group.add(seg);
            // Occasional border stones
            if (!lowDetail && rng(s * 29 + w * 31) > 0.78) {
              const side = rng(s * 33 + w * 41) > 0.5 ? 1 : -1;
              const stone = new THREE.Mesh(boulderGeo, stoneMat);
              const stx = px + Math.cos(yaw) * side * (trailWidth * 0.55 + 0.2);
              const stz = pz - Math.sin(yaw) * side * (trailWidth * 0.55 + 0.2);
              const sty = getIslandSurfaceY(island, stx, stz);
              stone.position.set(stx - island.position.x, sty + 0.16, stz - island.position.z);
              stone.scale.setScalar(0.18 + rng(s * 47 + w * 53) * 0.18);
              stone.rotation.set(rng(s * 51) * Math.PI, rng(s * 57) * Math.PI, rng(s * 61) * Math.PI);
              stone.castShadow = true;
              group.add(stone);
            }
          }
        }

        // Trailhead post at the dock side
        if (island.dock) {
          const head = new THREE.Group();
          const hx = island.dock.respawnPoint.x;
          const hz = island.dock.respawnPoint.z;
          const hy = getIslandSurfaceY(island, hx, hz);
          head.position.set(hx - island.position.x, hy, hz - island.position.z);
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.5, 0.18), new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 }));
          post.position.y = 0.75;
          post.castShadow = true;
          head.add(post);
          const sign = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.32, 0.06), new THREE.MeshStandardMaterial({ color: 0x6e4c25, roughness: 0.95 }));
          sign.position.set(0.42, 1.25, 0);
          head.add(sign);
          group.add(head);
        }
      }
    }

    // ── Reef ring — sharp dark rocks just offshore ──
    {
      const reefMatDark = new THREE.MeshStandardMaterial({ color: 0x282520, roughness: 1 });
      const reefMatWet = new THREE.MeshStandardMaterial({ color: 0x3a3328, roughness: 0.9 });
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
        reef.position.set(fx, seaY + stickOut, fz);
        const scale = 0.7 + rng(i * 433) * 1.4;
        reef.scale.set(scale * (0.7 + rng(i * 437) * 0.6), scale * (0.6 + rng(i * 441) * 1.2), scale * (0.7 + rng(i * 443) * 0.6));
        reef.rotation.set(rng(i * 447) * 0.6, rng(i * 449) * Math.PI * 2, (rng(i * 451) - 0.5) * 0.6);
        reef.castShadow = false;
        reef.receiveShadow = true;
        group.add(reef);

        // Add a small splash collar of foam (a flat ring sliver) for ones poking above water
        if (stickOut > 0.05 && !lowDetail) {
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

    // ── Sharp rock spires — jagged peaks for mountain/rocky islands ──
    if (island.profile.terrainStyle === 'mountain' || island.profile.terrainStyle === 'rocky') {
      const spireMat = new THREE.MeshStandardMaterial({ color: 0x4d4338, roughness: 1, flatShading: true });
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

    // ── Bridges — rope-and-plank, rendered from the SERVER's replicated
    // registry: endpoints are true terrain local-maxima found at generation,
    // and the deck players walk on is the shared getBridgeDeckY math, so the
    // bridge is genuinely solid and both ends sit flush on their peaks (the
    // old client-only version guessed hill centers and connected to nothing).
    for (const islandBridge of island.bridges ?? []) {
      const a = { lx: islandBridge.ax - island.position.x, lz: islandBridge.az - island.position.z, y: islandBridge.ay };
      const b = { lx: islandBridge.bx - island.position.x, lz: islandBridge.bz - island.position.z, y: islandBridge.by };
      const dx = b.lx - a.lx;
      const dz = b.lz - a.lz;
      const span = Math.hypot(dx, dz);
      {
        const bridge = new THREE.Group();
        const midX = (a.lx + b.lx) * 0.5;
        const midZ = (a.lz + b.lz) * 0.5;
        const yaw = Math.atan2(dx, dz);
        // Anchor bridge at midpoint, midpoint y = average of the two peaks (so each end rests at its peak)
        const midY = (a.y + b.y) * 0.5;
        bridge.position.set(midX, midY, midZ);
        bridge.rotation.y = yaw;
        // Tilt bridge so each end matches its own peak height (rotate around X axis;
        // local +Z corresponds to peak b after rotation.y, so we need negative tilt).
        const tilt = Math.atan2(b.y - a.y, span);
        bridge.rotation.x = -tilt;

        const plankMat2 = new THREE.MeshStandardMaterial({ color: 0x6b4623, roughness: 0.95 });
        const ropeMat2 = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
        const postMat2 = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1 });

        // End posts: their bases sit at z = ±span/2 in local space (which maps to each peak after tilt)
        for (const end of [-1, 1] as const) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.6, 0.32), postMat2);
          post.position.set(0, 0.8, end * span * 0.5);
          post.castShadow = true;
          bridge.add(post);
          const cap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), postMat2);
          cap.position.set(0, 1.7, end * span * 0.5);
          bridge.add(cap);
          // Anchoring cairn (so the post visually grounds into the rock)
          for (let s = 0; s < 4; s++) {
            const stone = new THREE.Mesh(boulderGeo, boulderMat);
            const ang = (s / 4) * Math.PI * 2;
            stone.position.set(Math.cos(ang) * 0.5, 0.18, end * span * 0.5 + Math.sin(ang) * 0.5);
            stone.scale.setScalar(0.22 + rng(s * 851 + (end > 0 ? 1 : 2)) * 0.18);
            stone.rotation.set(rng(s * 853) * Math.PI, rng(s * 857) * Math.PI, rng(s * 859) * Math.PI);
            bridge.add(stone);
          }
        }

        // Sagging plank deck — sag is measured from the y=0 reference plane (bridge midline)
        const plankCount = Math.max(8, Math.floor(span / 0.55));
        for (let i = 0; i < plankCount; i++) {
          const t = (i + 0.5) / plankCount;
          const z = (t - 0.5) * span;
          const sag = -Math.sin(t * Math.PI) * Math.min(0.9, span * 0.04);
          const plank = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.42), plankMat2);
          plank.position.set((rng(i * 601) - 0.5) * 0.05, sag, z);
          plank.rotation.z = (rng(i * 607) - 0.5) * 0.04;
          plank.rotation.x = (rng(i * 611) - 0.5) * 0.03;
          plank.castShadow = true;
          plank.receiveShadow = true;
          bridge.add(plank);
        }

        // Two rope rails
        const ropeSegments = 24;
        for (const side of [-1, 1] as const) {
          const railPositions: number[] = [];
          for (let i = 0; i <= ropeSegments; i++) {
            const t = i / ropeSegments;
            const z = (t - 0.5) * span;
            const sag = -Math.sin(t * Math.PI) * Math.min(0.6, span * 0.03);
            railPositions.push(side * 0.7, 0.78 + sag, z);
          }
          const railGeo = new THREE.BufferGeometry();
          railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railPositions, 3));
          const rail = new THREE.Line(railGeo, new THREE.LineBasicMaterial({ color: 0xc8b27a }));
          bridge.add(rail);

          // Lower handhold rope
          const lowerPos: number[] = [];
          for (let i = 0; i <= ropeSegments; i++) {
            const t = i / ropeSegments;
            const z = (t - 0.5) * span;
            const sag = -Math.sin(t * Math.PI) * Math.min(0.9, span * 0.04);
            lowerPos.push(side * 0.6, 0.04 + sag, z);
          }
          const lowerGeo = new THREE.BufferGeometry();
          lowerGeo.setAttribute('position', new THREE.Float32BufferAttribute(lowerPos, 3));
          const lower = new THREE.Line(lowerGeo, new THREE.LineBasicMaterial({ color: 0xc8b27a }));
          bridge.add(lower);

          // Vertical lashings
          const verticalCount = Math.max(6, Math.floor(span / 1.2));
          for (let v = 0; v < verticalCount; v++) {
            const tv = (v + 0.5) / verticalCount;
            const zv = (tv - 0.5) * span;
            const sagTop = -Math.sin(tv * Math.PI) * Math.min(0.6, span * 0.03);
            const sagBot = -Math.sin(tv * Math.PI) * Math.min(0.9, span * 0.04);
            const lash = new THREE.Mesh(
              new THREE.CylinderGeometry(0.02, 0.02, Math.max(0.5, 0.78 - 0.04 + sagTop - sagBot), 4),
              ropeMat2,
            );
            lash.position.set(side * 0.65, (0.78 + sagTop + 0.04 + sagBot) * 0.5, zv);
            bridge.add(lash);
          }
        }

        group.add(bridge);
      }
    }

    // ── Peak mist — tall summits wear a slow ring of cloud (SoT reference) ──
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

    if (!lowDetail && r > 48) {
      const ruin = new THREE.Group();
      const ruinAngle = island.profile.primaryHillAngle + rng(islandSeed * 17) * 0.8;
      const ruinPos = surfacePoint(0.18 + rng(islandSeed * 23) * 0.18, ruinAngle, 0.02);
      ruin.position.copy(ruinPos);
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

      if (isSolidDecorPoint(ruinPos, SURFACE_ABOVE_WATER, -0.2)) group.add(ruin);
    }

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

    {
      const detailRoot = new THREE.Group();
      detailRoot.name = 'island-detail-root';
      while (group.children.length > 0) {
        detailRoot.add(group.children[0]);
      }

      // ── Micro-decor tier ──────────────────────────────────────────────
      // Islands used to render EVERY bespoke decor mesh (shells, rubble,
      // stalactites, tidepools, camp clutter…) out to the full detail radius —
      // ~370 visible meshes per island, ~3.7k scene-wide, most far too small
      // to read past 250m. Reparent small pieces into a near-only tier: no
      // shadow casting, hidden beyond microRadius in updateEnvironmentLod.
      const microRoot = new THREE.Group();
      microRoot.name = 'island-micro-root';
      {
        const keepNames = new Set(['island-terrain', 'island-shore-skirt']);
        const bbox = new THREE.Box3();
        const size = new THREE.Vector3();
        const micro: THREE.Object3D[] = [];
        for (const child of detailRoot.children) {
          if (keepNames.has(child.name)) continue;
          if (child instanceof THREE.InstancedMesh) continue; // prop batches stay
          bbox.setFromObject(child);
          if (bbox.isEmpty()) continue;
          bbox.getSize(size);
          if (Math.max(size.x, size.y, size.z) < 3.6) micro.push(child);
        }
        for (const child of micro) {
          microRoot.add(child);
          child.traverse((obj) => {
            if (obj instanceof THREE.Mesh) obj.castShadow = false;
          });
        }
        detailRoot.add(microRoot);
      }

      // Proxy LOD = a genuine low-res sample of the same shared heightfield
      // with the same biome coloring, so distant islands keep their true
      // silhouette, coast shape, and palette — no pop, no monochrome domes.
      const proxyRoot = new THREE.Group();
      proxyRoot.name = 'island-proxy-root';
      proxyRoot.visible = false;
      {
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
        proxyRoot.add(proxyMesh);
      }

      if (lowDetail) {
        detailRoot.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = false;
            obj.receiveShadow = false;
          }
        });
      }
      proxyRoot.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = false;
          obj.receiveShadow = true;
        }
      });

      group.add(detailRoot);
      group.add(proxyRoot);
      group.userData.detailRoot = detailRoot;
      group.userData.proxyRoot = proxyRoot;
    }

    this.environment.add(group);
    this.islandMeshes.set(island.id, group);

    for (const chest of island.chests) {
      const chestGroup = new THREE.Group();
      chestGroup.position.set(chest.position.x, chest.position.y, chest.position.z);

      const surfaceY = getIslandSurfaceY(island, chest.position.x, chest.position.z);

      let chestMesh: THREE.Object3D;
      let lid: THREE.Object3D;
      const chestGlb = this.buildPropInstance(
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

      this.environment.add(chestGroup);
      this.chestMeshes.set(chest.id, { root: chestGroup, glow, chestMesh, lid, mound });
    }

    for (const barrel of island.barrels) {
      const barrelRoot = new THREE.Group();
      barrelRoot.position.set(barrel.position.x, barrel.position.y, barrel.position.z);
      const barrelGlb = this.buildPropInstance(
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
      bartender: 0x6f3320,
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
      bartender: 0x5a2a18,
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
    } else if (npc.role === 'bartender') {
      // No rug — bartender stands behind the bar inside the tavern building.
      rug.visible = false;
      const tankard = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.3, 8), brassMat);
      tankard.position.set(0.55, 1.12, -0.05);
      tankard.castShadow = true;
      root.add(tankard);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 10, Math.PI), brassMat);
      handle.rotation.y = Math.PI * 0.5;
      handle.position.set(0.69, 1.12, -0.05);
      root.add(handle);
    } else {
      // Supply crate GLB (0.72³ footprint, origin at ground) with the old box fallback.
      const crateGlb = this.buildPropInstance('crate', new THREE.Vector3(-0.82, 0.02, -0.2), 0.35, 0.75);
      if (crateGlb) {
        root.add(crateGlb);
      } else {
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.52, 0.58), propMat);
        crate.position.set(-0.82, 0.28, -0.2);
        crate.castShadow = true;
        root.add(crate);
      }
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
    light.visible = false; // gated to ~55m by updateEnvironmentLod (light budget)
    root.userData.decorLight = this.renderer.getQuality() === 'low' ? null : light;
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
    const rawDtMs = now - this.lastFrameTime;
    const dt = Math.min(0.05, rawDtMs / 1000);
    this.lastFrameTime = now;
    this.frameDt = dt;
    // True frame time for the debug overlay (physics dt above is clamped to
    // 50ms for sim stability, which was pinning 'worst' at exactly 50.0).
    this.debugRawFrameMs = rawDtMs;
    this.minimapTimer -= dt;
    this.inputSendTimer -= dt;
    this.inputHeartbeatTimer -= dt;
    this.windWispTimer -= dt;
    this.rainOverlayTimer -= dt;

    if (this.serverTimeOffset !== null) {
      this.ocean.setWaveTime(performance.now() / 1000 + this.serverTimeOffset);
    }
    this.ocean.update(dt, this.renderer.camera.position);
    this.ocean.setAtmosphere(this.renderer.getAtmosphere());
    this.updateScene(dt);

    const hasForcedInput = this.input.hasPendingActions() || this.pendingInteractFromUi || this.pendingLaunchFromUi;
    if (this.network.isConnected() && (this.inputSendTimer <= 0 || hasForcedInput)) {
      if (this.input.consumeLegendPressed()) {
        const legend = document.getElementById('controls-hint');
        if (legend) legend.style.display = legend.style.display === 'block' ? 'none' : 'block';
      }
      const input = this.input.buildInput();
      if (this.spyglassActive) {
        // A raised spyglass occupies both hands.
        input.fire = false;
        input.aim = false;
      }
      if (input.useWheelItem && input.wheelIndex !== null) {
        this.startPocketUsePreview(input.wheelIndex);
      }
      const uiInteract = this.pendingInteractFromUi;
      if (this.pendingInteractFromUi) {
        input.interact = true;
        this.pendingInteractFromUi = false;
      }
      const currentInteractKind = this.resolveCurrentInteractKind();
      input.interactIntent = input.interact
        ? (currentInteractKind ?? (uiInteract ? this.lastInteractKind : null))
        // Bail is a continuous hold, so its intent must ride every held frame — not
        // just the press edge — for the server's held-interact drain to keep running.
        // Bail, revive and the sail halyard are continuous holds — their
        // intent must ride every held frame for the server-side work to run.
        : (input.interactHeld
          && (currentInteractKind === 'bail' || currentInteractKind === 'revive' || currentInteractKind === 'sails')
          ? currentInteractKind
          : null);
      if (this.pendingLaunchFromUi) {
        input.jumpPressed = true;
        this.pendingLaunchFromUi = false;
      }
      const signature = this.getInputSignature(input);
      const changed = signature !== this.lastSentInputSignature;
      if (hasForcedInput || changed || this.inputHeartbeatTimer <= 0) {
        this.network.sendInput(input);
        this.lastSentInputSignature = signature;
        this.inputHeartbeatTimer = CLIENT_INPUT_HEARTBEAT_INTERVAL;
      }
      this.inputSendTimer = CLIENT_INPUT_SEND_INTERVAL;
    }

    this.updateStationMarkers();
    this.updateCapstanHands();
    this.updateMuzzleFlash(dt);
    if (!this.bugSnapListenerBound) {
      this.bugSnapListenerBound = true;
      window.addEventListener('keydown', this.bugSnapListener);
    }
    this.updateMermaid(now);
    // Stream one queued island build per frame (join used to build all 10
    // synchronously and freeze the tab for seconds).
    this.drainIslandBuildQueue(1);
    this.renderer.updatePerformance(dt);
    this.renderer.render();
    if (this.bugSnapRequested) {
      this.bugSnapRequested = false;
      try {
        const image = this.renderer.renderer.domElement.toDataURL('image/png');
        const player = this.getLocalPlayer();
        const ship = player?.onShipId ? this.shipsById.get(player.onShipId) : null;
        const meta = {
          at: new Date().toISOString(),
          position: player?.position ?? null,
          state: player?.state ?? null,
          onShipId: player?.onShipId ?? null,
          shipType: ship?.type ?? null,
          nearestIsland: (() => {
            let best: { id: string; d: number } | null = null;
            for (const island of this.state?.islands ?? []) {
              const d = this.distance2D(player?.position.x ?? 0, player?.position.z ?? 0, island.position.x, island.position.z);
              if (!best || d < best.d) best = { id: island.id, d: Math.round(d) };
            }
            return best;
          })(),
          fps: Math.round(this.debugFps),
          note: 'F8 bug snap',
        };
        void fetch('/bugsnap', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image, meta }),
        }).then(() => this.pushFeed('Bug snap saved — thanks, captain!', '#7ce38b'))
          .catch(() => this.pushFeed('Bug snap failed to save', '#ff8a7a'));
      } catch {
        this.pushFeed('Bug snap failed to capture', '#ff8a7a');
      }
    }
    this.updatePointerLockHint();
    this.updateDebugPerfPanel(dt);

    requestAnimationFrame((time) => this.frame(time));
  }

  private setupDebugPerfPanel() {
    if (!this.debugPerfEnabled || this.debugPerfPanel) return;

    const panel = document.createElement('div');
    panel.id = 'debug-perf-panel';
    panel.style.cssText = [
      'position:fixed',
      'left:10px',
      'bottom:10px',
      'z-index:99999',
      'min-width:260px',
      'max-width:380px',
      'padding:9px 10px',
      'border:1px solid rgba(141,185,255,0.42)',
      'border-radius:6px',
      'background:rgba(4,11,23,0.78)',
      'box-shadow:0 8px 28px rgba(0,0,0,0.35)',
      'color:#d9e8ff',
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre',
      'pointer-events:none',
      'text-shadow:0 1px 2px rgba(0,0,0,0.7)',
    ].join(';');
    panel.textContent = 'Pirates BR debug\nwaiting for first frame...';
    document.body.appendChild(panel);
    this.debugPerfPanel = panel;
  }

  private updateDebugPerfPanel(dt: number) {
    if (!this.debugPerfPanel) return;

    this.debugFrameCounter++;
    this.debugFrameAccum += dt;
    this.debugWorstFrameMs = Math.max(this.debugWorstFrameMs, this.debugRawFrameMs);
    this.debugUpdateTimer -= dt;
    if (this.debugUpdateTimer > 0) return;

    this.debugFps = this.debugFrameCounter / Math.max(0.001, this.debugFrameAccum);
    const worstFrame = this.debugWorstFrameMs;
    this.debugFrameCounter = 0;
    this.debugFrameAccum = 0;
    this.debugWorstFrameMs = 0;
    this.debugUpdateTimer = 0.5;

    const info = this.renderer.renderer.info;
    const player = this.getLocalPlayer();
    const ship = this.getTrackedShip();
    const activeWeapon = player?.weapons[player.activeSlot] ?? null;
    const averageHull = ship
      ? (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) * 25
      : null;
    const prompt = (this.ui.interactPrompt.textContent ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const snapshotAgeMs = performance.now() - this.lastSnapshotAt;

    const stateLine = this.state
      ? [
          `state ${this.state.phase}`,
          `ships ${this.state.shipsAlive}/${this.state.ships.length}`,
          `players ${this.state.players.length}`,
          `proj ${this.state.projectiles.length}`,
          `kegs ${this.state.kegs.length}`,
        ].join(' | ')
      : 'state menu/waiting';

    const playerLine = player
      ? [
          `player ${player.state}`,
          `hp ${Math.round(player.health)}`,
          `onShip ${player.onShipId ? 'yes' : 'no'}`,
          `helm ${player.atHelm ? 'Y' : 'n'}`,
          `cannon ${player.atCannon ? player.cannonIndex : 'n'}`,
          `sails ${player.atSails ? 'Y' : 'n'}`,
          `weapon ${activeWeapon?.weaponId ?? 'none'}`,
        ].join(' | ')
      : 'player none';

    const shipLine = ship
      ? [
          `ship ${ship.type}`,
          `hull ${Math.round(averageHull ?? 0)}%`,
          `sail ${Math.round(ship.sailHeight * 100)}%`,
          `anchor ${ship.anchored ? `down ${Math.round((ship.anchorRaiseProgress ?? 0) * 100)}%` : 'up'}`,
          `speed ${Math.hypot(ship.velocity.x, ship.velocity.z).toFixed(1)}`,
        ].join(' | ')
      : 'ship none';

    this.debugPerfPanel.textContent = [
      'Pirates BR debug',
      `fps ${this.debugFps.toFixed(0)} | worst ${worstFrame.toFixed(1)}ms | quality ${this.renderer.getQuality()} | dpr ${this.renderer.renderer.getPixelRatio().toFixed(2)}`,
      `draw ${info.render.calls} | tris ${info.render.triangles} | geom ${info.memory.geometries} | tex ${info.memory.textures}`,
      stateLine,
      playerLine,
      shipLine,
      `snapshot ${Math.round(snapshotAgeMs)}ms | interact ${this.visibleInteractKind ?? this.lastInteractKind ?? 'none'} | prompt ${prompt || 'none'}`,
    ].join('\n');
  }

  private updateEnvironmentLod() {
    if (!this.state) return;

    const quality = this.renderer.getQuality();
    const cam = this.renderer.camera.position;
    // Islands are THE landmark visuals: hold full detail out to AAA distances,
    // measured from the island EDGE (footprint radius), not its center — a
    // 200m-radius island's shoreline used to flip to proxy while you stood on it.
    const detailRadius = quality === 'low' ? 420 : quality === 'balanced' ? 700 : 950;
    const wildlifeRadius = quality === 'low' ? 220 : quality === 'balanced' ? 360 : 520;
    const lootRadius = quality === 'low' ? 340 : quality === 'balanced' ? 520 : 760;
    const seaRockRadius = quality === 'low' ? 650 : quality === 'balanced' ? 900 : 1200;
    const upgradeRadius = quality === 'low' ? 420 : quality === 'balanced' ? 620 : 820;
    const npcRadius = quality === 'low' ? 360 : quality === 'balanced' ? 560 : 760;

    for (const island of this.state.islands) {
      const group = this.islandMeshes.get(island.id);
      if (!group) continue;
      const dist = this.distance2D(cam.x, cam.z, island.position.x, island.position.z);
      const detailRoot = group.userData.detailRoot as THREE.Object3D | undefined;
      const proxyRoot = group.userData.proxyRoot as THREE.Object3D | undefined;
      if (detailRoot && proxyRoot) {
        const edgeDist = dist - getIslandMaxRadius(island);
        const showDetail = edgeDist < detailRadius;
        detailRoot.visible = showDetail;
        proxyRoot.visible = !showDetail;
        // Micro decor (shells, rubble, clutter) only reads up close — culling
        // it past ~260m cuts hundreds of draw calls per distant island.
        const microRoot = detailRoot.getObjectByName('island-micro-root');
        if (microRoot) microRoot.visible = showDetail && edgeDist < (quality === 'low' ? 180 : 260);
        for (const layerName of ['island-grass', 'island-ferns', 'island-shells'] as const) {
          const layer = detailRoot.getObjectByName(layerName);
          if (layer) layer.visible = showDetail && edgeDist < (layerName === 'island-shells' ? 200 : 300);
        }
        // Cave interiors: only visible when the camera is within ~55m of the
        // entrance, so their dark boxy slabs never show poking through the
        // hillside from across the map.
        const caveGroups = group.userData.caveGroups as THREE.Object3D[] | undefined;
        if (caveGroups) {
          for (const caveGroup of caveGroups) {
            const e = caveGroup.userData.caveEntranceWorld as { x: number; y: number; z: number };
            const cd = this.distance2D(cam.x, cam.z, e.x, e.z);
            caveGroup.visible = showDetail && cd < 34;
          }
        }
      }

      for (const chest of island.chests) {
        const record = this.chestMeshes.get(chest.id);
        if (!record) continue;
        const chestDist = this.distance2D(cam.x, cam.z, chest.position.x, chest.position.z);
        const carriedByLocal = chest.carriedByPlayerId === this.localPlayerId;
        record.root.visible = chestDist < lootRadius && !chest.opened && !carriedByLocal;
        const chestLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (chestLight) chestLight.visible = record.root.visible && chestDist < 55;
      }

      for (const barrel of island.barrels) {
        const root = this.barrelMeshes.get(barrel.id);
        if (!root) continue;
        const barrelDist = this.distance2D(cam.x, cam.z, barrel.position.x, barrel.position.z);
        root.visible = barrelDist < lootRadius && (!barrel.opened || barrel.loot.length > 0);
      }

      for (const station of island.upgradeStations) {
        const record = this.upgradeStationMeshes.get(station.id);
        if (!record) continue;
        const stationDist = this.distance2D(cam.x, cam.z, station.position.x, station.position.z);
        record.root.visible = stationDist < upgradeRadius;
        const stationLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (stationLight) stationLight.visible = record.root.visible && stationDist < 55;
      }

      for (const npc of island.npcs ?? []) {
        const record = this.npcMeshes.get(npc.id);
        if (!record) continue;
        const npcDist = this.distance2D(cam.x, cam.z, npc.position.x, npc.position.z);
        record.root.visible = npcDist < npcRadius;
        const npcLight = record.root.userData.decorLight as THREE.PointLight | null | undefined;
        if (npcLight) npcLight.visible = record.root.visible && npcDist < 55;
      }
    }

    for (const animal of this.state.wildlife ?? []) {
      const mesh = this.wildlifeMeshes.get(animal.id);
      if (!mesh) continue;
      const dist = this.distance2D(cam.x, cam.z, animal.position.x, animal.position.z);
      mesh.visible = animal.health > 0 && dist < (animal.type === 'gull' ? wildlifeRadius * 1.35 : wildlifeRadius);
    }

    for (const rock of this.state.seaRocks ?? []) {
      const mesh = this.seaRockMeshes.get(rock.id);
      if (!mesh) continue;
      const dist = this.distance2D(cam.x, cam.z, rock.position.x, rock.position.z);
      mesh.visible = dist < seaRockRadius;
    }
  }

  private getInputSignature(input: PlayerInput): string {
    return [
      input.forward ? 1 : 0,
      input.back ? 1 : 0,
      input.left ? 1 : 0,
      input.right ? 1 : 0,
      input.jump ? 1 : 0,
      input.fire ? 1 : 0,
      input.aim ? 1 : 0,
      input.interactHeld ? 1 : 0,
      input.sailRaise ? 1 : 0,
      input.sailLower ? 1 : 0,
      input.sailLeft ? 1 : 0,
      input.sailRight ? 1 : 0,
      input.dropChest ? 1 : 0,
      input.specialAttack ? 1 : 0,
      input.slot ?? '',
      input.cannonAmmo ?? '',
      input.interactIntent ?? '',
      Math.round(input.yaw * 1000),
      Math.round(input.pitch * 1000),
    ].join('|');
  }

  /** SoT-style station beacons: soft pulsing rings floating over the anchor
   *  capstan, the sail rigging, and the helm while you're aboard your ship —
   *  you can SEE where to go from across the deck. The anchor ring burns
   *  red while the anchor is down (the #1 'why is my ship not moving'). */
  private stationMarkers: { anchor: THREE.Sprite; sails: THREE.Sprite; helm: THREE.Sprite } | null = null;

  private setupMuzzleFlash() {
    // Radial flare texture for the flash + smoke, drawn once.
    const tex = (inner: string, outer: string) => {
      const size = 64;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, inner);
      g.addColorStop(0.5, outer);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      return new THREE.CanvasTexture(c);
    };
    const flashTex = tex('rgba(255,246,214,1)', 'rgba(255,168,52,0.7)');
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0, depthTest: false, depthWrite: false,
    }));
    this.muzzleFlash.renderOrder = 1000;
    this.muzzleFlash.visible = false;
    this.localViewWeaponRoot.add(this.muzzleFlash);
    this.muzzleGlow = new THREE.PointLight(0xffb347, 0, 6, 2);
    this.localViewWeaponRoot.add(this.muzzleGlow);
    const smokeTex = tex('rgba(180,180,180,0.6)', 'rgba(120,120,120,0.25)');
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: smokeTex, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
      }));
      s.renderOrder = 999;
      s.visible = false;
      this.localViewWeaponRoot.add(s);
      this.muzzleSmoke.push(s);
    }
  }

  /** Barrel-tip offset per weapon (local to the viewmodel root). */
  private muzzleTipFor(weaponId: WeaponId): [number, number, number] {
    switch (weaponId) {
      case 'eye_of_reach': return [0, 0.075, 1.5];
      case 'blunderbuss': return [0, 0.055, 1.0];
      case 'flintknock': return [0, 0.05, 0.62];
      default: return [0, 0.05, 0.7];
    }
  }

  private triggerMuzzleFlash(weaponId: WeaponId) {
    if (!this.muzzleFlash || !this.muzzleGlow) return;
    const [tx, ty, tz] = this.muzzleTipFor(weaponId);
    const scatter = weaponId === 'blunderbuss' ? 1.5 : 1;
    this.muzzleFlash.position.set(tx, ty, tz);
    const flashScale = (weaponId === 'blunderbuss' ? 0.55 : weaponId === 'eye_of_reach' ? 0.4 : 0.32) * scatter;
    this.muzzleFlash.scale.set(flashScale, flashScale, 1);
    this.muzzleFlash.material.rotation = Math.sin(this.ocean.getTime() * 91.7) * Math.PI;
    this.muzzleFlash.visible = true;
    this.muzzleFlash.material.opacity = 1;
    this.muzzleGlow.position.set(tx, ty, tz);
    this.muzzleGlow.intensity = 5 * scatter;
    this.muzzleFlashTimer = 0.09;
    // Smoke puffs drift forward from the barrel and fade.
    for (let i = 0; i < this.muzzleSmoke.length; i++) {
      const s = this.muzzleSmoke[i];
      s.position.set(tx + (Math.sin(i * 2.1) * 0.05), ty + 0.02 + i * 0.015, tz + 0.05 + i * 0.04);
      s.scale.setScalar(0.12 + i * 0.04);
      s.material.opacity = 0.5 - i * 0.08;
      s.visible = true;
      s.userData.smokeLife = 0.5 + i * 0.12;
      s.userData.smokeAge = 0;
    }
  }

  private updateMuzzleFlash(dt: number) {
    if (this.muzzleFlash && this.muzzleFlashTimer > 0) {
      this.muzzleFlashTimer -= dt;
      const k = Math.max(0, this.muzzleFlashTimer / 0.09);
      this.muzzleFlash.material.opacity = k;
      if (this.muzzleGlow) this.muzzleGlow.intensity = 5 * k;
      if (this.muzzleFlashTimer <= 0) {
        this.muzzleFlash.visible = false;
        if (this.muzzleGlow) this.muzzleGlow.intensity = 0;
      }
    }
    for (const s of this.muzzleSmoke) {
      if (!s.visible) continue;
      s.userData.smokeAge = (s.userData.smokeAge ?? 0) + dt;
      const life = s.userData.smokeLife ?? 0.5;
      const a = s.userData.smokeAge / life;
      if (a >= 1) { s.visible = false; continue; }
      s.position.z += dt * 0.5;
      s.position.y += dt * 0.12;
      s.scale.setScalar(s.scale.x + dt * 0.35);
      s.material.opacity = (1 - a) * 0.4;
    }
  }

  private buildCapstanHands() {
    if (this.capstanHandsBuilt) return;
    this.capstanHandsBuilt = true;
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x7a3f2a, roughness: 0.92 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc98d5f, roughness: 0.85 });
    const barMat = new THREE.MeshStandardMaterial({ color: 0x4a331e, roughness: 0.9 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), barMat);
    bar.rotation.z = Math.PI * 0.5;
    bar.position.set(0, -0.32, -0.62);
    this.localViewHandsRoot.add(bar);
    for (const side of [-1, 1] as const) {
      const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.42, 8), sleeveMat);
      forearm.position.set(side * 0.24, -0.42, -0.44);
      forearm.rotation.x = -1.05;
      forearm.rotation.z = side * 0.18;
      this.localViewHandsRoot.add(forearm);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.075, 0.13), skinMat);
      hand.position.set(side * 0.22, -0.325, -0.6);
      this.localViewHandsRoot.add(hand);
      for (let f = 0; f < 3; f++) {
        const finger = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.024), skinMat);
        finger.position.set(side * 0.22 - 0.026 + f * 0.026, -0.29, -0.655);
        finger.rotation.x = 0.7;
        this.localViewHandsRoot.add(finger);
      }
    }
  }

  /** Show working hands on the capstan bar while the anchor hold runs. */
  private updateCapstanHands() {
    const player = this.getLocalPlayer();
    const ship = player?.onShipId ? this.shipsById.get(player.onShipId) : null;
    // Show the crank hands the instant you grab the capstan (holding X with
    // the anchor interaction resolved), not only once the anchor is already
    // rising — the old progress>0.001 gate made them flicker/never show.
    const cranking = !!player && !!ship
      && ship.anchored
      && this.input.isInteractHeld()
      && (this.visibleInteractKind === 'anchor' || this.lastInteractKind === 'anchor');
    if (cranking) this.buildCapstanHands();
    this.localViewHandsRoot.visible = !!cranking;
    if (cranking) {
      this.localViewWeaponRoot.visible = false;
      const t = this.ocean.getTime();
      // push rhythm: lean into the bar, sway with the crank
      this.localViewHandsRoot.position.set(
        Math.sin(t * 3.1) * 0.045,
        Math.abs(Math.sin(t * 3.1)) * -0.03,
        Math.sin(t * 6.2) * 0.02,
      );
      this.localViewHandsRoot.rotation.z = Math.sin(t * 3.1) * 0.06;
    }
  }

  private updateStationMarkers() {
    // Retired: the floating beacon orbs read as UI garbage in-world (they
    // glowed through sniper scopes at night). Stations are now marked by
    // PHYSICAL implements — rope coils on the rails, the capstan itself —
    // plus the [X] prompts. Keep sprites hidden if they were ever created.
    if (this.stationMarkers) {
      this.stationMarkers.anchor.visible = false;
      this.stationMarkers.sails.visible = false;
      this.stationMarkers.helm.visible = false;
    }
  }

  private updateMermaid(now: number): void {
    const player = this.getLocalPlayer();
    const ship = player ? this.getMermaidReturnShip(player) : null;
    if (!player || !ship) {
      this.mermaidAnchor = null;
      if (this.mermaidGroup.visible) this.mermaidGroup.visible = false;
      return;
    }
    if (
      !this.mermaidAnchor
      || this.mermaidAnchor.shipId !== ship.id
      || this.distance2D(player.position.x, player.position.z, this.mermaidAnchor.x, this.mermaidAnchor.z) > 62
    ) {
      this.mermaidAnchor = this.createMermaidAnchor(player, ship);
    }
    const phase = (this.mermaidGroup.userData.bobPhase as number) ?? 0;
    const bob = Math.sin(now * 0.0023 + phase) * 0.12;
    // Ride the real sea — a fixed 0.18 left her hovering over troughs and
    // submerged under storm crests.
    const mermaidWaveY = gerstnerHeight(
      this.mermaidAnchor.x, this.mermaidAnchor.z, this.ocean.getTime(), WAVE_PARAMS,
      getStormWaveIntensity(this.state?.storm, this.mermaidAnchor.x, this.mermaidAnchor.z),
    );
    this.mermaidGroup.position.set(this.mermaidAnchor.x, mermaidWaveY + 0.14 + bob, this.mermaidAnchor.z);
    this.mermaidGroup.rotation.y = Math.atan2(
      player.position.x - this.mermaidAnchor.x,
      player.position.z - this.mermaidAnchor.z,
    );
    this.mermaidGroup.visible = true;
  }

  private createMermaidAnchor(player: Player, ship: Ship) {
    const dx = ship.position.x - player.position.x;
    const dz = ship.position.z - player.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const offset = Math.min(8, Math.max(5, len * 0.12));
    return {
      x: player.position.x + (dx / len) * offset,
      z: player.position.z + (dz / len) * offset,
      shipId: ship.id,
    };
  }

  private updatePointerLockHint(): void {
    if (!this.pointerLockHintEl) {
      this.pointerLockHintEl = document.getElementById('pointer-lock-hint');
    }
    if (!this.pointerLockHintEl) return;
    const inMatch = !!this.localPlayerId;
    const menuVisible = this.menu.isVisible();
    const showHint = inMatch && !menuVisible && !this.input.isLocked();
    this.pointerLockHintEl.classList.toggle('visible', showHint);
  }

  private updateScene(dt: number) {
    if (!this.state) {
      return;
    }

    this.audioFrameTriggers(dt);
    // Single source of night-ness for every warm-light system this frame.
    const nightFactor = THREE.MathUtils.clamp(this.renderer.getAtmosphere().nightFactor, 0, 1);
    this.shipRenderer.setNightFactor(nightFactor);
    this.updateLanterns(nightFactor, this.renderer.camera.position, this.ocean.getTime());
    const snapshotAge = Math.min(0.22, (performance.now() - this.lastSnapshotAt) / 1000);
    this.shipRenderer.update(
      this.state.ships,
      this.state.players,
      this.ocean.getTime(),
      dt,
      snapshotAge,
      this.renderer.camera.position,
      this.localPlayerId ?? undefined,
      // Ring form: the renderer evaluates the shared storm sea-state per ship,
      // so hulls straddling the wall ride the same swell the ocean draws.
      this.state.storm
        ? { center: { x: this.state.storm.centerX, y: this.state.storm.centerZ }, safeRadius: this.state.storm.safeRadius, phase: this.state.storm.phase }
        : 0,
    );
    this.syncSharks(dt);
    this.syncWildlife(dt);
    this.updateEnvironmentLod();
    // Per-frame so the wall/ring track the shrink smoothly instead of stepping
    // only when snapshots arrive.
    this.updateStormRing();
    this.stormWall.rotation.y = this.ocean.getTime() * 0.035;
    this.stormWallTexture.offset.x = this.ocean.getTime() * 0.018;
    this.stormHalo.rotation.z = this.ocean.getTime() * 0.12;
    this.stormWeatherIntensity = this.computeStormWeatherIntensity();
    // (renderer storm weather is applied via updateWaterEnvironment below —
    // calling updateStormWeather here too did the same work twice per frame)
    this.ocean.setStormIntensity(this.stormWeatherIntensity);
    // Storm SEA GEOMETRY (separate from the color tint above): the shader
    // mirrors getStormWaveIntensity, so waves genuinely rage inside the ring.
    // phase01 must match the shared formula: clamp(phase / 6, 0, 1) — phase is
    // 0-indexed over the 7 STORM_PHASES.
    if (this.debugStormDemo) {
      // Park a tiny full-power ring at the camera: locally we are deep outside
      // it, so the shared sea-state formula returns ~1 right here.
      const cam = this.renderer.camera.position;
      this.stormWeatherIntensity = 0.7;
      this.ocean.setStormIntensity(0.7);
      // Positive radius, ring parked far away: we are ~780m outside it, so the
      // shared sea-state formula returns 1 here. (A negative radius hits the
      // shader's no-storm sentinel and silently disables the swell geometry.)
      this.ocean.setStormState(cam.x + 900, cam.z, 120, 1);
    } else if (this.state?.storm) {
      const storm = this.state.storm;
      this.ocean.setStormState(
        storm.centerX,
        storm.centerZ,
        storm.safeRadius,
        THREE.MathUtils.clamp(storm.phase / 6, 0, 1),
      );
    } else {
      this.ocean.clearStormState();
    }
    const effectScale = this.renderer.getEffectScale();
    // World-space rain runs every frame (cheap buffer update; the old canvas
    // overlay throttle is gone with the overlay).
    this.updateStormRain3D(dt, this.debugStormDemo ? 0.9 : this.computeStormRainIntensity());
    this.updateStormLightningFlash(dt);
    const stormW = this.stormWeatherIntensity;
    const wallMat = this.stormWall.material as THREE.MeshBasicMaterial;
    wallMat.opacity = 0.18 + stormW * 0.28;
    wallMat.color.copy(this.stormWallColorClear).lerp(this.stormWallColorStorm, stormW);
    const haloMat = this.stormHalo.material as THREE.MeshBasicMaterial;
    haloMat.opacity = 0.08 + stormW * 0.16;
    this.combatFx.update(dt);
    this.syncKegs(dt);
    this.slowSceneTimer -= dt;
    if (this.slowSceneTimer <= 0) {
      this.updateUpgradeStations(Math.max(dt, 0.1));
      this.updateStoryNpcs(Math.max(dt, 0.1));
      this.slowSceneTimer = 0.1;
    }
    this.syncPlayers(dt);
    this.syncProjectiles(dt);
    this.updateCamera();
    this.updateWaterEnvironment();
    this.updateCombatHud(dt);
    this.syncLocalViewWeapon();
    if (this.windWispTimer <= 0) {
      this.updateWindWisps();
      this.windWispTimer = effectScale < 0.55 ? 1 / 20 : effectScale < 0.85 ? 1 / 30 : 0;
    }
    this.updateLightning(dt);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.updateHud();
      this.hudTimer = effectScale < 0.55 ? 0.09 : 0.06;
    }
    if (this.minimapTimer <= 0) {
      this.drawMaps();
      this.minimapTimer = effectScale < 0.55 ? 0.5 : effectScale < 0.85 ? 0.35 : 0.25;
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
      vy += PHYSICS.GRAVITY * step;
      px += vx * step;
      py += vy * step;
      pz += vz * step;
    }
    this.tempBallisticPos.set(px, py, pz);
    return this.tempBallisticPos;
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
    if (isLocal && !player.atHelm && !player.atCannon && !player.atSails) {
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
        const predictionWindow = Math.min(0.22, snapshotAge + leadSeconds + 0.04);
        const verticalIntent = this.input.getSwimVerticalIntent();
        if (moveAxes.x !== 0 || moveAxes.z !== 0) {
          const yaw = this.input.getYaw();
          const pitch = this.input.getPitch();
          const len = Math.hypot(moveAxes.x, moveAxes.z) || 1;
          const nx = moveAxes.x / len;
          const nz = moveAxes.z / len;
          predictedX += (Math.sin(yaw) * nz - Math.cos(yaw) * nx) * PLAYER.SWIM_SPEED * predictionWindow * 1.05;
          predictedZ += (Math.cos(yaw) * nz + Math.sin(yaw) * nx) * PLAYER.SWIM_SPEED * predictionWindow * 1.05;
          visualY += Math.sin(pitch) * nz * PLAYER.SWIM_SPEED * predictionWindow * 0.72;
        }
        if (verticalIntent !== 0) {
          visualY += verticalIntent * PLAYER.SWIM_SPEED * predictionWindow * 0.68;
        }
      }
    }
    if (player.state === 'swimming') {
      const t = this.ocean.getTime();
      const swimStorm = getStormWaveIntensity(this.state?.storm, predictedX, predictedZ);
      const waveY = gerstnerHeight(predictedX, predictedZ, t, WAVE_PARAMS, swimStorm);
      const waterSurface = waveY + 0.28;
      const targetFeetY = waterSurface - 0.18;
      // Only snap the visual to the surface when the SERVER position is also
      // near the surface and the player isn't actively plunging. Otherwise the
      // snap was pulling the visual up to the surface during a deep cannon dive,
      // making it look like the player splashed without ever going under.
      const serverDepth = waterSurface - player.position.y;
      const plunging = player.velocity.y < -1.2;
      const depthBelowSurface = waterSurface - visualY;
      if (!plunging && serverDepth < 0.6 && depthBelowSurface < 1.15) {
        const waveSnap = isLocal ? 0.7 : 0.6;
        visualY = THREE.MathUtils.lerp(visualY, targetFeetY, waveSnap);
      } else if (!plunging && serverDepth < 1.4 && depthBelowSurface < 2.0 && player.velocity.y > -0.35) {
        // Gentle pull as the player surfaces and starts to bob with the waves
        visualY = THREE.MathUtils.lerp(visualY, targetFeetY, 0.14);
      }

      // Hull collision parity: mirror the authoritative resolveSwimmerShipCollision
      // so a swimmer never *visually* clips into a ship hull (or rubber-bands out
      // when the server correction arrives). Uses the same shared footprint math.
      if (!player.onShipId && !player.cannonBallistic && this.state) {
        const hullMargin = PLAYER.RADIUS + 0.18;
        for (const ship of this.state.ships) {
          if (!ship.alive || ship.sinking) continue;
          const stats = SHIP_STATS[ship.type];
          const band = getSwimHullVerticalBand(ship.position.y, stats);
          const dx = predictedX - ship.position.x;
          const dz = predictedZ - ship.position.z;
          const cos = Math.cos(ship.rotation);
          const sin = Math.sin(ship.rotation);
          const localX = dx * cos - dz * sin;
          const localZ = dx * sin + dz * cos;
          if (!isInsideSwimHullFootprint(stats, localX, localZ, hullMargin)) continue;
          if (visualY < band.keelY) {
            if (visualY > band.keelY - (PLAYER.HEIGHT + 0.4)) visualY = Math.min(visualY, band.keelY - 0.02);
            continue;
          }
          if (visualY > band.deckY + 0.35) continue;
          const out = pushOutOfSwimHullFootprint(stats, localX, localZ, hullMargin);
          if (!out.pushed) continue;
          predictedX = ship.position.x + out.x * cos + out.z * sin;
          predictedZ = ship.position.z + out.z * cos - out.x * sin;
        }
      }
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

        if (isPointInsideIslandFootprint(island, predictedX, predictedZ, 0)) {
          // Mirror the server's islandStandY: inside a cave tunnel the
          // authoritative floor is the carved cave floor, 2-6m below the
          // natural hillside — snapping to the hilltop made players pop out
          // of caves and jitter against server corrections.
          let standY = getIslandSurfaceY(island, predictedX, predictedZ);
          const caveCeil = getCaveCeilingY(island, predictedX, predictedZ);
          if (caveCeil !== null && player.position.y < caveCeil - 0.1) {
            const caveFloor = getCaveFloorY(island, predictedX, predictedZ);
            if (caveFloor !== null && caveFloor < standY) standY = caveFloor;
          }
          resolvedSurfaceY = Math.max(resolvedSurfaceY, standY + 0.03);
        }
        // Rope-bridge decks are real floors (mirror the server's step gate).
        for (const islandBridge of island.bridges ?? []) {
          const deckY = getBridgeDeckY(islandBridge, predictedX, predictedZ);
          if (deckY !== null && player.position.y > deckY - 1.2) {
            resolvedSurfaceY = Math.max(resolvedSurfaceY, deckY + 0.03);
          }
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
    this.tempRenderPos.set(predictedX, visualY, predictedZ);
    return this.tempRenderPos;
  }

  private getPlayerTeamColor(player: Player): number {
    const homeShip = player.shipId ? this.shipsById.get(player.shipId) ?? null : null;
    const currentShip = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
    return homeShip?.teamColor
      ?? currentShip?.teamColor
      ?? (player.id === this.localPlayerId ? 0x6f2d22 : player.isBot ? 0x9a3340 : 0x365879);
  }

  private getPlayerTeamRole(player: Player): 'captain' | 'crew' | 'raider' {
    const homeShip = player.shipId ? this.shipsById.get(player.shipId) ?? null : null;
    if (homeShip?.ownerId === player.id) return 'captain';
    return player.shipId ? 'crew' : 'raider';
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
      const playerIsSkeleton = player.isBot && player.shipId === null;
      const playerTeamColor = playerIsSkeleton ? 0xd7d1c4 : this.getPlayerTeamColor(player);
      let mesh = this.playerMeshes.get(player.id);
      if (!mesh) {
        mesh = makePlayerMesh(
          playerTeamColor,
          playerIsSkeleton ? 'skeleton' : 'pirate',
          playerIsSkeleton ? 'crew' : this.getPlayerTeamRole(player),
        );
        this.playerMeshes.set(player.id, mesh);
        this.renderer.scene.add(mesh);
      } else if (!playerIsSkeleton) {
        applyPlayerTeamColor(mesh, playerTeamColor);
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
        if (mesh.position.distanceToSquared(targetPos) > (isLocal ? 20 * 20 : 34 * 34)) {
          mesh.position.copy(targetPos);
        } else {
          mesh.position.lerp(targetPos, positionAlpha);
        }
        mesh.rotation.y += angleWrap(targetYaw - mesh.rotation.y) * (isLocal ? 1 : rotationAlpha);
      }

      // Downed pirates read prone at a glance: tipped onto their side, sunk to
      // ground level, with a slow pained sway while they crawl/bleed out.
      const downedLean = mesh.userData.downedLean as number | undefined ?? 0;
      const downedTarget = player.state === 'downed' ? 1 : 0;
      const nextLean = downedLean + (downedTarget - downedLean) * Math.min(1, dt * 6);
      mesh.userData.downedLean = nextLean;
      if (nextLean > 0.002) {
        mesh.rotation.z = (Math.PI * 0.42 + Math.sin(this.ocean.getTime() * 1.7) * 0.05) * nextLean;
        mesh.position.y -= 0.55 * nextLean;
      } else if (mesh.rotation.z !== 0 && player.state !== 'eliminated') {
        mesh.rotation.z = 0;
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
          if (player.state === 'downed') {
            // Downed: show bleed-out red, or revive teal while a mate holds X.
            if ((player.reviveProgress ?? 0) > 0) {
              fillMat.color.setHSL(0.45, 0.75, 0.55);
              healthBar.fill.scale.x = Math.max(0.001, player.reviveProgress ?? 0);
            } else {
              fillMat.color.setHSL(0.995, 0.85, 0.5);
            }
            fillMat.opacity = 0.9;
          } else {
            fillMat.color.setHSL(0.02 + ratio * 0.31, 0.82, 0.56);
            fillMat.opacity = 0.68 + ratio * 0.28;
          }
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
          // Chainshot that dies above the water almost certainly caught rigging —
          // tear canvas audibly (visual scraps come from emitImpact's chainshot case).
          if (projectileType === 'chainshot' && mesh.position.y > 0.9) {
            const d = this.distance2D(
              this.renderer.camera.position.x, this.renderer.camera.position.z,
              mesh.position.x, mesh.position.z,
            );
            this.audio.playSailRip(d);
          }
        }
        this.lastChainshotWhirrAt.delete(projectileId);
        this.renderer.scene.remove(mesh);
        this.disposeSceneObject(mesh);
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
        // Own-ship broadside just fired — brief FOV pop + a touch of shake.
        if (projectile.ownerShipId && projectile.ownerShipId === this.localShipId && projectile.type !== 'bullet') {
          this.cameraShakeCannon = 1;
          this.cameraShake = Math.min(1, this.cameraShake + 0.18);
        }
      }
      mesh.userData.projectileType = projectile.type;
      mesh.userData.showImpact = projectile.showImpact;
      mesh.position.lerp(
        this.tempProjectilePos.set(projectile.position.x, projectile.position.y, projectile.position.z),
        1 - Math.exp(-24 * dt),
      );
      if (projectile.type === 'tsunami') {
        mesh.rotation.y = Math.atan2(projectile.velocity.x, projectile.velocity.z);
        const life = 1 - Math.min(1, projectile.age / Math.max(0.001, projectile.maxAge));
        mesh.scale.set(1 + projectile.age * 0.18, 1 + (1 - life) * 0.35, 1 + projectile.age * 0.55);
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = Math.max(0, 0.42 * life);
      } else if (mesh.userData.chainshot) {
        // Whirl the ball-and-chain in flight; lay a pale trail; whistle by distance.
        mesh.rotation.y += dt * 15;
        mesh.rotation.x += dt * 5.5;
        this.combatFx.emitTrail(projectile.position, 0x9fd0ff);
        const nowT = this.ocean.getTime();
        const last = this.lastChainshotWhirrAt.get(projectile.id) ?? -1;
        if (nowT - last > 0.5) {
          const d = this.distance2D(
            this.renderer.camera.position.x, this.renderer.camera.position.z,
            projectile.position.x, projectile.position.z,
          );
          this.audio.playChainshotWhirr(d);
          this.lastChainshotWhirrAt.set(projectile.id, nowT);
        }
      }
    }
  }

  private syncKegs(dt: number) {
    if (!this.state) return;

    for (const [kegId, mesh] of this.kegMeshes) {
      if (!this.liveKegIds.has(kegId)) {
        this.renderer.scene.remove(mesh.root);
        this.disposeSceneObject(mesh.root);
        this.kegMeshes.delete(kegId);
      }
    }

    for (const keg of this.state.kegs) {
      if (keg.timer <= 0) continue;
      let mesh = this.kegMeshes.get(keg.id);
      let created = false;
      if (!mesh) {
        const root = new THREE.Group();
        const mega = !!keg.mega;
        const kegGlb = mega
          ? assets.cloneTinted('keg', 'Wood_Dark', 0x1d0e08)
          : assets.clone('keg');
        if (kegGlb) {
          kegGlb.scale.setScalar(0.62);
          kegGlb.position.y = -0.3;
          root.add(kegGlb);
        } else {
          const barrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.26, 0.58, 10),
            new THREE.MeshStandardMaterial({
              color: mega ? 0x2a1510 : 0x5a3418,
              emissive: mega ? 0x4a0f08 : 0x000000,
              emissiveIntensity: mega ? 0.26 : 0,
              roughness: 0.92,
            }),
          );
          barrel.castShadow = true;
          root.add(barrel);

          const bandMat = new THREE.MeshStandardMaterial({ color: mega ? 0xd89b3a : 0x2b2b2b, roughness: 0.45, metalness: 0.85 });
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
        }

        const fuse = new THREE.PointLight(mega ? 0xff3226 : 0xff7a26, mega ? 2.2 : 1.2, mega ? 6.5 : 3.5);
        fuse.position.set(0.04, 0.48, 0);
        root.add(fuse);
        root.scale.setScalar(mega ? 1.55 : 1);

        this.renderer.scene.add(root);
        mesh = { root, fuse };
        this.kegMeshes.set(keg.id, mesh);
        created = true;
      }

      this.tempKegPos.set(keg.position.x, keg.position.y + 0.28, keg.position.z);
      const moveAlpha = 1 - Math.exp(-28 * dt);
      if (created || mesh.root.position.distanceToSquared(this.tempKegPos) > 16 * 16) {
        mesh.root.position.copy(this.tempKegPos);
      } else {
        mesh.root.position.lerp(this.tempKegPos, moveAlpha);
      }
      const hostShip = keg.shipId ? this.shipsById.get(keg.shipId) ?? null : null;
      const targetYaw = hostShip?.rotation ?? 0;
      mesh.root.rotation.y += angleWrap(targetYaw - mesh.root.rotation.y) * (1 - Math.exp(-24 * dt));
      const megaBoost = keg.mega ? 1.75 : 1;
      mesh.root.scale.setScalar(keg.mega ? 1.55 : 1);
      mesh.fuse.intensity = megaBoost * (0.6 + Math.max(0.2, Math.sin((SHIP.KEG_FUSE_TIME - keg.timer) * 12) * 0.35 + (1 - Math.min(1, keg.timer / SHIP.KEG_FUSE_TIME)) * 2.1));
    }
  }

  private syncChests() {
    if (!this.state) return;
    const showGlow = this.renderer.getQuality() !== 'low';

    for (const island of this.state.islands) {
      for (const chest of island.chests) {
        const chestMesh = this.chestMeshes.get(chest.id);
        if (!chestMesh) continue;
        chestMesh.root.position.set(chest.position.x, chest.position.y, chest.position.z);
        const carriedByLocal = chest.carriedByPlayerId === this.localPlayerId;
        chestMesh.root.visible = !chest.opened && !carriedByLocal;
        const portable = !!chest.carriedByPlayerId || !!chest.storedOnShipId || chest.floating;
        const dug = portable || chest.digProgress >= 1;
        if (chest.buried && chestMesh.mound) {
          chestMesh.mound.visible = !chest.opened && !portable && !dug;
          const s = Math.max(0.06, 1 - chest.digProgress * 0.95);
          chestMesh.mound.scale.setScalar(s);
        }
        chestMesh.chestMesh.visible = !chest.opened && (!chest.buried || dug);
        chestMesh.lid.visible = chestMesh.chestMesh.visible;
        chestMesh.glow.visible = showGlow && !chest.opened && (dug || !chest.buried) && !carriedByLocal;
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
        root.visible = !barrel.opened || barrel.loot.length > 0;
      }
    }
  }

  private syncSharks(dt: number) {
    if (!this.state) return;
    const sharks = this.state.sharks ?? [];
    const seen = new Set<string>();
    for (const shark of sharks) {
      if (shark.health <= 0) continue;
      seen.add(shark.id);
      let mesh = this.sharkMeshes.get(shark.id);
      let created = false;
      if (!mesh) {
        mesh = this.buildSharkMesh();
        this.environment.add(mesh);
        this.sharkMeshes.set(shark.id, mesh);
        created = true;
      }
      this.tempSharkPos.set(shark.position.x, shark.position.y + 0.15, shark.position.z);
      const moveAlpha = 1 - Math.exp(-18 * dt);
      if (created || mesh.position.distanceToSquared(this.tempSharkPos) > 55 * 55) {
        mesh.position.copy(this.tempSharkPos);
      } else {
        mesh.position.lerp(this.tempSharkPos, moveAlpha);
      }
      mesh.rotation.y += angleWrap(shark.rotation - mesh.rotation.y) * (1 - Math.exp(-16 * dt));
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

  private syncWildlife(dt: number) {
    if (!this.state) return;
    const seen = new Set<string>();
    const t = this.ocean.getTime();
    for (const animal of this.state.wildlife ?? []) {
      if (animal.health <= 0) continue;
      seen.add(animal.id);
      let mesh = this.wildlifeMeshes.get(animal.id);
      let created = false;
      if (!mesh) {
        mesh = this.buildWildlifeMesh(animal);
        this.environment.add(mesh);
        this.wildlifeMeshes.set(animal.id, mesh);
        created = true;
      }

      this.tempWildlifePos.set(animal.position.x, animal.position.y, animal.position.z);
      const alpha = 1 - Math.exp(-16 * dt);
      if (created || mesh.position.distanceToSquared(this.tempWildlifePos) > 18 * 18) {
        mesh.position.copy(this.tempWildlifePos);
      } else {
        mesh.position.lerp(this.tempWildlifePos, alpha);
      }
      mesh.rotation.y += angleWrap(animal.rotation - mesh.rotation.y) * (1 - Math.exp(-14 * dt));
      mesh.position.y += animal.type === 'gull'
        ? Math.sin(t * 8 + animal.position.x * 0.03) * 0.025
        : Math.sin(t * 10 + animal.position.x * 0.07) * 0.01;

      const parts = mesh.userData.parts as Record<string, THREE.Object3D | undefined> | undefined;
      const phase = t * (animal.type === 'gull' ? 9.5 : animal.type === 'chicken' ? 11 : animal.type === 'crab' ? 14 : 6.5)
        + animal.position.x * 0.04
        + animal.position.z * 0.03;
      if (parts?.leftWing) parts.leftWing.rotation.z = 0.35 + Math.sin(phase) * 0.55;
      if (parts?.rightWing) parts.rightWing.rotation.z = -0.35 - Math.sin(phase) * 0.55;
      if (parts?.head) parts.head.rotation.y = Math.sin(phase * 0.55) * 0.22;
      if (parts?.body) parts.body.rotation.z = Math.sin(phase) * (animal.type === 'crab' ? 0.035 : 0.02);
      for (let leg = 0; leg < 6; leg++) {
        const limb = parts?.[`leg${leg}`];
        if (limb) limb.rotation.z = (leg % 2 === 0 ? 1 : -1) * (0.18 + Math.sin(phase + leg) * 0.16);
      }
    }

    for (const [id, mesh] of this.wildlifeMeshes) {
      if (!seen.has(id)) {
        this.combatFx.emitSharkDeathBloom(
          { x: mesh.position.x, y: mesh.position.y + 0.12, z: mesh.position.z },
          this.renderer.camera.position,
        );
        this.environment.remove(mesh);
        this.wildlifeMeshes.delete(id);
      }
    }
  }

  private buildWildlifeMesh(animal: WildlifeAnimal): THREE.Group {
    const group = new THREE.Group();
    group.name = `wildlife-${animal.id}`;
    const parts: Record<string, THREE.Object3D> = {};
    group.userData.parts = parts;

    const add = (name: string, mesh: THREE.Object3D) => {
      mesh.name = name;
      parts[name] = mesh;
      group.add(mesh);
      return mesh;
    };

    if (this.renderer.getQuality() === 'low') {
      const color =
        animal.type === 'crab' ? 0xb53a2b :
        animal.type === 'chicken' ? 0xe8dcc4 :
        animal.type === 'pig' ? 0xc58d7d :
        0xf2f0e8;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 5), mat));
      body.position.y = animal.type === 'gull' ? 0 : animal.type === 'crab' ? 0.08 : 0.28;
      body.scale.set(
        animal.type === 'pig' ? 2.0 : animal.type === 'crab' ? 1.45 : animal.type === 'gull' ? 1.45 : 1.05,
        animal.type === 'pig' ? 1.05 : animal.type === 'crab' ? 0.42 : animal.type === 'gull' ? 0.72 : 1.2,
        animal.type === 'pig' ? 1.0 : animal.type === 'crab' ? 0.9 : 0.85,
      );

      if (animal.type !== 'crab') {
        const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), mat));
        head.position.set(animal.type === 'pig' ? 0.42 : 0.18, body.position.y + 0.16, 0);
      }

      if (animal.type === 'gull') {
        const wingMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc4, roughness: 0.82, side: THREE.DoubleSide });
        for (const side of [-1, 1]) {
          const wing = add(side < 0 ? 'leftWing' : 'rightWing', new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.16), wingMat));
          wing.position.set(0, 0.0, side * 0.16);
          wing.rotation.set(0.12, 0, side * 0.42);
        }
      }

      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = false;
          obj.receiveShadow = false;
        }
      });
      return group;
    }

    if (animal.type === 'crab') {
      const mat = new THREE.MeshStandardMaterial({ color: 0xb53a2b, roughness: 0.86 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 5), mat));
      body.scale.set(1.35, 0.48, 0.9);
      for (const side of [-1, 1]) {
        const claw = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), mat);
        claw.position.set(0.2, 0.02, side * 0.18);
        claw.scale.set(1.3, 0.7, 1);
        group.add(claw);
        for (let leg = 0; leg < 3; leg++) {
          const limb = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.018, 0.026), mat);
          limb.position.set(-0.05 - leg * 0.055, -0.03, side * (0.12 + leg * 0.055));
          limb.rotation.y = side * (0.55 + leg * 0.18);
          add(`leg${side > 0 ? leg : leg + 3}`, limb);
        }
      }
    } else if (animal.type === 'chicken') {
      const feather = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.92 });
      const red = new THREE.MeshStandardMaterial({ color: 0xb82e24, roughness: 0.8 });
      const beak = new THREE.MeshStandardMaterial({ color: 0xd9a33f, roughness: 0.75 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), feather));
      body.scale.set(1.0, 1.15, 0.82);
      body.position.y = 0.22;
      const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), feather));
      head.position.set(0.18, 0.43, 0);
      const crest = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), red);
      crest.position.set(0.18, 0.55, 0);
      group.add(crest);
      const bill = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 5), beak);
      bill.position.set(0.29, 0.43, 0);
      bill.rotation.z = -Math.PI * 0.5;
      group.add(bill);
      for (const side of [-1, 1]) {
        const wing = add(side < 0 ? 'leftWing' : 'rightWing', new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.14), feather));
        wing.position.set(0.02, 0.25, side * 0.16);
        wing.rotation.y = side * 0.65;
      }
    } else if (animal.type === 'pig') {
      const skin = new THREE.MeshStandardMaterial({ color: 0xc58d7d, roughness: 0.88 });
      const snoutMat = new THREE.MeshStandardMaterial({ color: 0xe2a69a, roughness: 0.86 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8), skin));
      body.scale.set(1.45, 0.82, 0.86);
      body.position.y = 0.34;
      const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 7), skin));
      head.position.set(0.45, 0.43, 0);
      const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.1, 8), snoutMat);
      snout.rotation.z = Math.PI * 0.5;
      snout.position.set(0.62, 0.42, 0);
      group.add(snout);
      for (let i = 0; i < 4; i++) {
        const leg = add(`leg${i}`, new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.28, 6), skin));
        leg.position.set(i < 2 ? -0.22 : 0.24, 0.05, i % 2 === 0 ? -0.18 : 0.18);
      }
    } else {
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.78 });
      const wingMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc4, roughness: 0.82, side: THREE.DoubleSide });
      const beakMat = new THREE.MeshStandardMaterial({ color: 0xd3a13b, roughness: 0.76 });
      const body = add('body', new THREE.Mesh(new THREE.SphereGeometry(0.14, 9, 6), bodyMat));
      body.scale.set(1.35, 0.72, 0.85);
      const head = add('head', new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 5), bodyMat));
      head.position.set(0.18, 0.08, 0);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 5), beakMat);
      beak.position.set(0.27, 0.08, 0);
      beak.rotation.z = -Math.PI * 0.5;
      group.add(beak);
      for (const side of [-1, 1]) {
        const wing = add(side < 0 ? 'leftWing' : 'rightWing', new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.16), wingMat));
        wing.position.set(0, 0.0, side * 0.14);
        wing.rotation.set(0.12, 0, side * 0.42);
      }
    }

    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    return group;
  }

  private buildSharkMesh(): THREE.Group {
    const g = new THREE.Group();
    const topMat = new THREE.MeshStandardMaterial({ color: 0x2a4a5c, roughness: 0.82, metalness: 0.08 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0x8aa8b8, roughness: 0.75, metalness: 0.02 });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x3a5c6e, roughness: 0.78, metalness: 0.05 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x071016, roughness: 0.9 });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xf4ead0, roughness: 0.62 });

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

    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.3), darkMat);
    mouth.position.set(1.26, -0.12, 0);
    mouth.rotation.z = -0.12;
    g.add(mouth);

    for (let i = 0; i < 7; i++) {
      const z = -0.18 + i * 0.06;
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.07, 4), toothMat);
      tooth.position.set(1.28, -0.16, z);
      tooth.rotation.z = Math.PI;
      tooth.rotation.x = i % 2 === 0 ? 0.12 : -0.12;
      g.add(tooth);
    }

    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const slit = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.012), darkMat);
        slit.position.set(0.55 - i * 0.07, 0.04, side * 0.36);
        slit.rotation.set(0.25, 0, side * 0.48);
        g.add(slit);
      }

      const flankStripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.025, 0.018),
        new THREE.MeshStandardMaterial({ color: 0x1d3544, roughness: 0.9 }),
      );
      flankStripe.position.set(-0.12, 0.2, side * 0.44);
      flankStripe.rotation.set(0.12, 0, side * 0.2);
      g.add(flankStripe);
    }

    const tailTop = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.58, 0.08), finMat);
    tailTop.position.set(-1.45, 0.34, 0);
    tailTop.rotation.z = -0.42;
    g.add(tailTop);
    const tailBottom = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.08), finMat);
    tailBottom.position.set(-1.43, -0.18, 0);
    tailBottom.rotation.z = 0.52;
    g.add(tailBottom);

    const rearDorsal = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 5), finMat);
    rearDorsal.position.set(-0.62, 0.38, 0);
    rearDorsal.rotation.z = Math.PI * 0.5;
    g.add(rearDorsal);

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
    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
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
    // Spyglass: hold P — 6° (~12x) beats the sniper's 14° by design. Active
    // when not manning a cannon, not aiming a firearm, and able to stand.
    const spyglassActive = this.input.isSpyglassHeld()
      && !aiming
      && !player.atCannon
      && player.state !== 'downed'
      && player.state !== 'respawning'
      && player.state !== 'eliminated';
    this.spyglassActive = spyglassActive;
    let targetFov = spyglassActive ? 6 : scopedFov ?? (aimingFirearm ? 64 : swimming ? 78 : 74);

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
    } else if (player.atHelm && trackedShip) {
      const stats = SHIP_STATS[trackedShip.type];
      const helmZ = -stats.length * 0.39;
      const starboardX = stats.width * 0.28;
      desired = this.getShipWorldPoint(
        trackedShip,
        starboardX,
        helmZ - stats.length * 0.02,
        stats.height + 1.48,
      );
      lookTarget = this.getShipWorldPoint(
        trackedShip,
        starboardX * 0.68,
        stats.length * 0.22,
        stats.height + 1.55,
      );
      targetFov = 78;
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

    const camera = this.renderer.camera;
    const onDeck = !!player.onShipId && !!trackedShip && !swimming;
    const shipSpeed01 = onDeck && trackedShip
      ? THREE.MathUtils.clamp(
          Math.hypot(trackedShip.velocity.x, trackedShip.velocity.z) / Math.max(SHIP_STATS[trackedShip.type].maxSpeed, 0.001),
          0, 1,
        )
      : 0;

    // ── FOV kick: +4° eased into full sail speed, +2° brief pop on own cannon fire.
    const fovKickTarget = shipSpeed01 * 4 + this.cameraShakeCannon * 2;
    this.cameraFovKick += (fovKickTarget - this.cameraFovKick) * Math.min(1, this.frameDt * 6);
    this.cameraShakeCannon = Math.max(0, this.cameraShakeCannon - this.frameDt * 3.2);
    const finalFov = targetFov + this.cameraFovKick;
    if (Math.abs(camera.fov - finalFov) > 0.02) {
      camera.fov += (finalFov - camera.fov) * Math.min(1, this.frameDt * 10);
      this.input.setFovScale(camera.fov / 74);
      camera.updateProjectionMatrix();
    }

    // ── Deck roll coupling: lean the view with the hull heel, clamped to ±0.06 rad.
    let rollTarget = 0;
    if (onDeck && trackedShip) {
      rollTarget = THREE.MathUtils.clamp(-(trackedShip.roll ?? 0) * 0.5, -0.06, 0.06);
    }
    this.cameraRoll += (rollTarget - this.cameraRoll) * Math.min(1, this.frameDt * 4);
    this.cameraRoll = THREE.MathUtils.clamp(this.cameraRoll, -0.06, 0.06);
    if (Math.abs(this.cameraRoll) > 0.0002) camera.rotateZ(this.cameraRoll);

    // ── Impact shake (own-hull hits) + a sluggish wallow when heavily flooded.
    this.cameraShake = Math.max(0, this.cameraShake - this.frameDt * 2.4);
    let shake = this.cameraShake;
    const water = onDeck && trackedShip ? (trackedShip.waterLevel ?? 0) : 0;
    if (water > 0.5) shake += (water - 0.5) * 0.14;
    if (shake > 0.0005) {
      const amp = Math.min(0.9, shake) * 0.12;
      const st = this.ocean.getTime();
      camera.rotateX(Math.sin(st * 41.0) * amp * 0.5);
      camera.rotateY(Math.cos(st * 37.0) * amp * 0.5);
      this.tempShakeVec.set(Math.sin(st * 53.0) * amp, Math.cos(st * 59.0) * amp, 0)
        .applyQuaternion(camera.quaternion);
      camera.position.add(this.tempShakeVec);
    }
  }

  private updateWaterEnvironment() {
    const camera = this.renderer.camera.position;
    const camStorm = getStormWaveIntensity(this.state?.storm, camera.x, camera.z);
    const waveY = gerstnerHeight(camera.x, camera.z, this.ocean.getTime(), WAVE_PARAMS, camStorm);
    this.combatFx.setWaterSurfaceY(waveY);
    const depthBelowSurface = Math.max(0, waveY + 0.18 - camera.y);
    this.renderer.updateWaterEnvironment(depthBelowSurface, this.stormWeatherIntensity, this.ocean.getTime());
    this.ocean.setSunDirection(this.renderer.getSunDirection());
    this.ocean.setUnderwaterDepth(depthBelowSurface);
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

  private getStormTimerSeconds() {
    if (!this.state) return 0;
    return this.state.storm.shrinking
      ? Math.max(0, Math.ceil((1 - this.state.storm.shrinkProgress) * this.state.storm.shrinkDuration))
      : Math.max(0, Math.ceil(this.state.storm.shrinkTimer));
  }

  private formatStormTimer(seconds: number) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
  }

  private updateBarrelPanel(player: Player, ship: Ship | null) {
    // Close the panel as soon as the player walks away from the barrel they were
    // browsing, or after a brief grace period if no event has refreshed it.
    if (this.barrelBrowse && player.nearBarrelId !== this.barrelBrowse.barrelId) {
      this.barrelBrowse = null;
    }
    if (this.barrelBrowse && performance.now() - this.barrelBrowse.lastEventAt > 12000) {
      this.barrelBrowse = null;
    }

    if (!this.barrelBrowse) {
      this.ui.barrelPanel.style.display = 'none';
      return;
    }

    this.ui.barrelPanel.style.display = 'block';

    const niceName = (item: string) => item.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const renderRows = (target: HTMLElement, rows: ItemStack[], emptyMsg: string) => {
      if (rows.length === 0) {
        target.innerHTML = `<div class="bp-empty">${emptyMsg}</div>`;
        return;
      }
      target.innerHTML = rows
        .map((r) => `<div class="bp-row"><span>${niceName(r.item)}</span><span class="bp-qty">×${r.qty}</span></div>`)
        .join('');
    };

    renderRows(this.ui.barrelPanelLoot, this.barrelBrowse.loot, '(empty)');

    // Player + ship inventory snapshot (combine pocket + ship inventory)
    const pocket: ItemStack[] = [];
    if (player.pocketBanana) pocket.push({ item: 'banana', qty: player.pocketBanana });
    if (player.pocketCoconut) pocket.push({ item: 'coconut', qty: player.pocketCoconut });
    if (player.pocketMango) pocket.push({ item: 'mango', qty: player.pocketMango });
    if (player.pocketMeat) pocket.push({ item: 'meat', qty: player.pocketMeat });
    if (player.pocketWood) pocket.push({ item: 'wood_plank', qty: player.pocketWood });
    const shipRows = ship ? ship.inventory.filter((s) => s.qty > 0) : [];
    const combined: ItemStack[] = [...pocket];
    for (const row of shipRows) {
      const existing = combined.find((c) => c.item === row.item);
      if (existing) existing.qty += row.qty;
      else combined.push({ ...row });
    }
    renderRows(this.ui.barrelPanelInventory, combined, ship ? '(empty hold)' : '(no ship — picks up to pockets)');
  }

  private updateHud() {
    if (!this.state) return;

    const player = this.getLocalPlayer();
    const ship = this.getTrackedShip();
    if (!player) return;

    this.updateBarrelPanel(player, ship);

    const timerSeconds = this.getStormTimerSeconds();
    const lastPhase = this.state.storm.phase >= STORM_PHASES.length - 1;
    const finalHold = lastPhase && !this.state.storm.shrinking && timerSeconds <= 0;
    const stormVerb = this.state.storm.shrinking ? 'CLOSING' : 'NEXT SHRINK';
    this.ui.stormPhase.textContent = finalHold
      ? 'FINAL STORM - NO SAFE HARBOR'
      : `STORM PHASE ${Math.min(this.state.storm.phase + 1, STORM_PHASES.length)} - ${stormVerb}`;
    this.ui.stormTimer.textContent = finalHold ? '' : this.formatStormTimer(timerSeconds);
    this.ui.mapSubtitle.textContent = finalHold
      ? 'The storm has fully closed — finish the fight'
      : this.state.storm.shrinking
        ? `Storm moving now · closes in ${timerSeconds}s`
        : `Next storm shift in ${timerSeconds}s`;

    const outsideStorm = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ) > this.state.storm.safeRadius;
    const avgHull = ship
      ? (ship.hull.bow + ship.hull.stern + ship.hull.port + ship.hull.starboard) / 4
      : 1;
    const shipCritical = !!ship && (ship.sinking || avgHull < 0.2);
    const shipOnFire = !!ship && ship.onFire && !ship.sinking;
    const localDowned = player.state === 'downed';
    this.ui.stormWarning.style.display = localDowned || outsideStorm || shipCritical || shipOnFire ? 'block' : 'none';
    if (localDowned) {
      const bleed = Math.max(0, Math.ceil(player.downedUntil ?? 0));
      this.ui.stormWarning.textContent = (player.reviveProgress ?? 0) > 0
        ? `CREWMATE REVIVING YOU — ${Math.round((player.reviveProgress ?? 0) * 100)}%`
        : `DOWNED — BLEEDING OUT 0:${String(bleed).padStart(2, '0')} · CRAWL TO YOUR CREW`;
      this.ui.stormWarning.style.color = (player.reviveProgress ?? 0) > 0 ? '#7ce38b' : '#ff6b6b';
    } else {
      this.ui.stormWarning.textContent = shipCritical
        ? (ship?.sinking ? 'SHIP IS SINKING' : 'SHIP CRITICAL - REPAIR NOW')
        : shipOnFire
          ? 'FIRE ABOARD - REPAIR TO DOUSE IT'
          : 'OUTSIDE STORM ZONE';
      this.ui.stormWarning.style.color = shipCritical || shipOnFire ? '#ffb366' : '#ff6b6b';
    }

    this.ui.shipsAlive.textContent = String(this.state.shipsAlive);
    this.ui.goldAmount.textContent = `${player.gold}/${ECONOMY.GOLD_WIN_TARGET}`;
    this.renderGoldLeaderboard(player.id);
    this.ui.killCount.textContent = String(player.kills);
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
      const windLine = `Wind ${windHeading} ${windArrow} ${windDegrees}deg ${windSide}`;
      this.ui.sailStatus.textContent = ship.anchored
        ? `Anchored · Hold [X] raise · ${windLine}`
        : `Sails ${Math.round(ship.sailHeight * 100)}%${rig} · Trim ${trimSide} · Catch ${Math.round(trimCatch * 100)}% · ${trimHint} · ${windLine}`;
    } else {
      this.ui.sailStatus.textContent = 'No tracked ship';
    }
    this.renderShipUpgrades(ship);
    this.renderShipInventory(ship, player);
    this.renderKegStatus(player);
    this.updateWaterGauge(player);

    let chestsInHold = 0;
    if (ship) {
      for (const isl of this.state.islands) {
        for (const ch of isl.chests) {
          if (ch.storedOnShipId === ship.id && !ch.opened) chestsInHold += 1;
        }
      }
    }
    const mappedIsland = player.treasureMapIslandId
      ? this.state.islands.find((island) => island.id === player.treasureMapIslandId) ?? null
      : null;
    const closestHoarder = this.getClosestGoldHoarder(player);
    const powerLine = this.getSpecialSummary(player);
    const objectiveLine = this.getObjectiveSummary(player, ship, {
      chestsInHold,
      mappedIsland,
      closestHoarder,
      outsideStorm,
      shipCritical,
      shipOnFire,
    });
    const progLine = ship
      ? `${objectiveLine} · ${powerLine} · Gold ${player.gold}/${ECONOMY.GOLD_WIN_TARGET} · Hold ${chestsInHold} · Upgrades ${ship.upgrades.length}`
      : `${objectiveLine} · ${powerLine}`;
    if (progLine !== this.brProgressSignature) {
      this.ui.brProgressFeed.textContent = progLine;
      this.brProgressSignature = progLine;
    }

    const pk = player;
    const stripParts = [
      `Pocket: 1 Banana ${pk.pocketBanana}`,
      `2 Plank ${pk.pocketWood}`,
      `3 Coconut ${pk.pocketCoconut}`,
      `4 Meat ${pk.pocketMeat} / Mango ${pk.pocketMango}`,
      `Tool: ${pk.hasShovel ? 'Shovel' : 'None'}`,
    ];
    if (mappedIsland) stripParts.push(`Chart: ${mappedIsland.name}`);
    if (closestHoarder && (mappedIsland || pk.carryingChestId)) stripParts.push(`Gold Hoarder: ${closestHoarder.island.name}`);
    if (pk.playerKillStreak > 0) stripParts.push(`Streak ${pk.playerKillStreak}`);
    const specialSummary = this.getSpecialSummary(pk);
    if (specialSummary) stripParts.push(specialSummary);
    const pocketText = stripParts.join(' | ');
    if (pocketText !== this.pocketStripSignature) {
      this.ui.pocketStrip.textContent = pocketText;
      this.pocketStripSignature = pocketText;
    }
    this.renderTreasureInventoryChart(player, mappedIsland, closestHoarder);
    this.ui.pocketWheelStats.textContent = this.input.isSupplyWheelOpen()
      ? 'Pocket: fruit heals you · wood transfers to Ship stores for repairs · kegs stay in equipment until placed'
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

    const weapon = player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    if (player.atCannon && ship) {
      const cb = this.getInventoryQty(ship, 'cannonball');
      this.ui.ammoCurrent.textContent =
        player.selectedCannonAmmo === 'cannonball'
          ? String(cb)
          : String(
              player.selectedCannonAmmo === 'firebomb'
                ? this.getInventoryQty(ship, 'firebomb_ball')
                : this.getInventoryQty(ship, 'chainshot'),
            );
      this.ui.ammoReserve.textContent =
        player.selectedCannonAmmo === 'cannonball'
          ? 'ship store (each shot spends 1)'
          : player.selectedCannonAmmo.replace('_', ' ');
      this.ui.reloadIndicator.style.display = ship.cannonCooldowns[player.cannonIndex] > 0 ? 'block' : 'none';
    } else {
      this.updateWeaponHud(player.activeSlot, weapon, player.weapons);
      const weaponDef = weapon ? WEAPONS[weapon.weaponId] : null;
      this.ui.reloadIndicator.style.display = weapon?.reloading && weaponDef && !weaponDef.melee ? 'block' : 'none';
    }
    this.ui.scopeOverlay.style.display =
      this.spyglassActive || (this.input.isAiming() && weapon && WEAPONS[weapon.weaponId].scopeFov) ? 'block' : 'none';
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
      const superShot = player.superCannonballs > 0 && player.selectedCannonAmmo === 'cannonball'
        ? ` · SUPER x5 ready (${player.superCannonballs})`
        : '';
      this.ui.contextLabel.textContent = `Cannon ${player.cannonIndex + 1} · ${player.selectedCannonAmmo.replace('_', ' ')}${superShot} · [5/6/7] shot type`;
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
      this.ui.interactPrompt.textContent = '';
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = '';
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
    } else if (player.carryingChestId) {
      this.ui.interactPrompt.style.display = 'block';
      this.ui.interactPrompt.textContent = '[B] Drop Chest';
      this.ui.contextLabel.style.display = 'block';
      this.ui.contextLabel.textContent = 'Carrying treasure · sell at Gold Hoarder or stow on ship';
    } else {
      this.ui.interactPrompt.style.display = 'none';
      const ambientLabel = player.state === 'swimming'
        ? 'Swimming · W follows look · Space up · Z down · LMB fire · Shift/RMB aim'
        : weapon?.weaponId === 'cutlass'
          ? `Cutlass · hold LMB to charge dash · Shift/RMB block · ${this.getKegSummary(player)}`
          : `[I] Supply wheel · Shift/RMB aim · ${this.getKegSummary(player)}`;
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
    const segments = this.renderer.getQuality() === 'low' ? 24 : this.renderer.getQuality() === 'balanced' ? 32 : 42;
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
    const nextStormX = centerX + this.state.storm.nextCenterX * scale;
    const nextStormY = centerY + this.state.storm.nextCenterZ * scale;
    const nextRadius = Math.max(0, this.state.storm.nextRadius * scale);
    const timerSeconds = this.getStormTimerSeconds();
    const stormLabel = `${this.state.storm.shrinking ? 'CLOSING' : 'NEXT'} ${this.formatStormTimer(timerSeconds)}`;

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
      ctx.arc(nextStormX, nextStormY, nextRadius, 0, Math.PI * 2);
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
    ctx.fillStyle = fullscreen ? 'rgba(5, 14, 28, 0.72)' : 'rgba(5, 14, 28, 0.68)';
    ctx.strokeStyle = 'rgba(201, 168, 76, 0.32)';
    ctx.lineWidth = 1.2;
    ctx.fillRect(8, 8, fullscreen ? 154 : 104, fullscreen ? 34 : 24);
    ctx.strokeRect(8, 8, fullscreen ? 154 : 104, fullscreen ? 34 : 24);
    ctx.fillStyle = this.state.storm.shrinking ? '#d7e8ff' : '#c9a84c';
    ctx.font = fullscreen ? '700 15px Georgia, serif' : '700 10px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(stormLabel, 15, fullscreen ? 26 : 20);
    ctx.restore();

    ctx.save();
    for (const island of this.state.islands) {
      this.drawIslandChart(ctx, island, centerX, centerY, scale, fullscreen);
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = fullscreen ? 'rgba(95, 91, 82, 0.92)' : 'rgba(95, 91, 82, 0.86)';
    ctx.strokeStyle = fullscreen ? 'rgba(235, 228, 204, 0.44)' : 'rgba(235, 228, 204, 0.36)';
    ctx.lineWidth = fullscreen ? 1.5 : 1;
    for (const rock of this.state.seaRocks ?? []) {
      const x = centerX + rock.position.x * scale;
      const y = centerY + rock.position.z * scale;
      const r = Math.max(fullscreen ? 4 : 2.5, rock.radius * scale);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
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
    const quality = this.renderer.getQuality();
    const detailSegments = quality === 'low'
      ? (fullscreen ? 16 : 10)
      : quality === 'balanced'
        ? (fullscreen ? 22 : 14)
        : (fullscreen ? 28 : 18);
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

    // Own-ship hull damage: shake the camera (scaled by the hit) and flash a
    // damage-direction arc toward the likeliest shooter (nearest enemy ship).
    const localShip = this.localShipId ? this.shipsById.get(this.localShipId) ?? null : null;
    if (localShip) {
      const total = localShip.hull.bow + localShip.hull.stern + localShip.hull.port + localShip.hull.starboard;
      if (localShip.id !== this.prevOwnShipId) {
        this.prevOwnShipId = localShip.id;
      } else {
        const drop = this.prevOwnHullTotal - total;
        if (drop > 0.01) {
          this.cameraShake = Math.min(1, this.cameraShake + THREE.MathUtils.clamp(drop * 1.6, 0.12, 0.8));
          const shooter = this.findNearestEnemyShip(localShip);
          if (shooter) this.spawnIncomingDamageDirection(shooter.position);
        }
      }
      this.prevOwnHullTotal = total;
    } else {
      this.prevOwnShipId = null;
      this.prevOwnHullTotal = 4;
    }
  }

  private findNearestEnemyShip(ownShip: Ship): Ship | null {
    if (!this.state) return null;
    let best: Ship | null = null;
    let bestDist = Infinity;
    for (const ship of this.state.ships) {
      if (ship.id === ownShip.id || !ship.alive) continue;
      const d = this.distance2D(ownShip.position.x, ownShip.position.z, ship.position.x, ship.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = ship;
      }
    }
    return best;
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

  /**
   * Per-frame edge-detection that fires sound effects driven by client state:
   * eating fruit, digging rhythm, chest pickup/stow, water entry, storm wind.
   */
  private audioFrameTriggers(dt: number) {
    if (!this.state) return;
    const player = this.getLocalPlayer();
    const localShip = this.localShipId ? this.state.ships.find((s) => s.id === this.localShipId) ?? null : null;
    const now = this.ocean.getTime();

    // Fruit/wood eat — fire on the rising edge of pocketUseCooldown.
    if (player) {
      const cooldown = player.pocketUseCooldown ?? 0;
      if (cooldown > this.prevPocketUseCooldown + 0.2) {
        const kind = this.pocketUsePreviewKind;
        if (kind === 'wood') {
          this.audio.playWoodPlank();
        } else if (kind === 'meat') {
          this.audio.playMeatEat();
        } else if (kind === 'banana' || kind === 'coconut' || kind === 'mango') {
          this.audio.playFruitEat(kind);
        } else {
          this.audio.playFruitEat('banana');
        }
      }
      this.prevPocketUseCooldown = cooldown;
    }

    // Carrying a chest — pickup vs stow vs drop.
    const carryingNow = player?.carryingChestId ?? null;
    if (carryingNow !== this.prevCarryingChestId) {
      if (carryingNow && !this.prevCarryingChestId) {
        this.audio.playChestPickup();
      } else if (!carryingNow && this.prevCarryingChestId) {
        const onShip = player?.onShipId && player.onShipId === this.localShipId;
        if (onShip) this.audio.playChestStow();
      }
      this.prevCarryingChestId = carryingNow;
    }

    // Water entry — alive→swimming transition.
    if (player) {
      const stateNow = player.state;
      if (this.prevPlayerStateForAudio && this.prevPlayerStateForAudio !== 'swimming' && stateNow === 'swimming') {
        const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z);
        this.audio.playSplash(THREE.MathUtils.clamp(speed / 12, 0.35, 1.4));
      }
      this.prevPlayerStateForAudio = stateNow;
    }

    // Digging strike rhythm — match the client-side animation cycle.
    const digChest = player?.nearChestId ? this.findChestById(player.nearChestId) : null;
    const digging =
      !!digChest
      && !!player?.hasShovel
      && this.input.isInteractHeld()
      && !player?.carryingChestId
      && digChest.buried
      && digChest.digProgress < 1;
    if (digging) {
      // Roughly two strikes per second — same rhythm the shovel viewmodel runs at.
      this.digStrikePhase += dt;
      if (this.digStrikePhase >= 0.55) {
        this.digStrikePhase = 0;
        this.audio.playDigStrike();
      }
    } else {
      this.digStrikePhase = 0;
    }

    // Storm wind ambient — louder as the safe zone shrinks past you.
    const stormPhase = this.state.storm?.phase ?? 0;
    if (stormPhase !== this.prevStormPhase) {
      this.prevStormPhase = stormPhase;
    }
    this.audio.setWindIntensity(THREE.MathUtils.clamp(this.stormWeatherIntensity, 0, 1));

    const localShipSpeed = localShip ? Math.hypot(localShip.velocity.x, localShip.velocity.z) : 0;
    const localShipStats = localShip ? SHIP_STATS[localShip.type] : null;
    const localShipMotion = localShipStats
      ? THREE.MathUtils.clamp(localShipSpeed / Math.max(localShipStats.maxSpeed, 0.001), 0, 1)
      : 0;
    const swimmingWaveBoost = player?.state === 'swimming' ? 0.26 : 0;
    this.audio.setWaveBed(THREE.MathUtils.clamp(0.36 + swimmingWaveBoost + localShipMotion * 0.32 + this.stormWeatherIntensity * 0.38, 0, 1));
    this.audio.setHullCreakIntensity(
      localShip ? THREE.MathUtils.clamp(0.18 + localShipMotion * 0.62 + this.stormWeatherIntensity * 0.28, 0, 1) : 0,
      localShipMotion,
    );

    if (localShip) {
      const hullSplashAmount = THREE.MathUtils.clamp(localShipMotion * 0.9 + this.stormWeatherIntensity * 0.38, 0, 1.25);
      const hullSplashInterval = THREE.MathUtils.clamp(1.15 - hullSplashAmount * 0.58 + Math.sin(now * 1.9) * 0.08, 0.38, 1.25);
      if (hullSplashAmount > 0.16 && now - this.lastHullSplashAt > hullSplashInterval) {
        this.audio.playHullSplash(hullSplashAmount);
        this.lastHullSplashAt = now;
      }
    }

    if (player?.state === 'swimming') {
      const swimSpeed = Math.hypot(player.velocity.x, player.velocity.z) + Math.abs(player.velocity.y) * 0.24;
      const swimInput = this.input.getMoveAxes();
      const swimIntent = Math.min(1, Math.hypot(swimInput.x, swimInput.z) + Math.abs(this.input.getSwimVerticalIntent()) * 0.65);
      const swimSplashAmount = THREE.MathUtils.clamp(swimSpeed / 5.6 + swimIntent * 0.45, 0, 1.15);
      if (swimSplashAmount > 0.22 && now - this.lastSwimSplashAt > 0.48) {
        this.audio.playSwimSplash(swimSplashAmount);
        this.lastSwimSplashAt = now;
      }
    }

    // Sail/anchor change cues for the local ship — physical deck feedback instead of UI clicks.
    if (localShip) {
      if (this.prevAnchored !== null && this.prevAnchored !== localShip.anchored) {
        this.audio.playAnchorChange(localShip.anchored);
      }
      this.prevAnchored = localShip.anchored;

      const anchorProgress = THREE.MathUtils.clamp(localShip.anchorRaiseProgress ?? 0, 0, 1);
      if (this.prevAnchorRaiseProgress !== null) {
        const anchorDelta = Math.abs(anchorProgress - this.prevAnchorRaiseProgress);
        const anchorMoving = localShip.anchored && anchorProgress > 0 && anchorProgress < 1 && anchorDelta > 0.0012;
        if (anchorMoving && now - this.lastAnchorMoveSoundAt > 0.16) {
          this.audio.playAnchorMovement(THREE.MathUtils.clamp(anchorDelta * 88 + 0.28, 0.32, 1.15));
          this.lastAnchorMoveSoundAt = now;
        }
      }
      this.prevAnchorRaiseProgress = anchorProgress;

      const helmAxes = this.input.getMoveAxes();
      const helmIntent = Math.abs(helmAxes.x);
      const helmMotion = Math.abs(localShip.angularVelocity);
      if (player?.atHelm && (helmIntent > 0 || helmMotion > 0.006)) {
        const helmAmount = THREE.MathUtils.clamp(helmIntent * 0.55 + helmMotion * 4.4 + localShipMotion * 0.18, 0.25, 1.15);
        const helmInterval = THREE.MathUtils.clamp(0.34 - helmAmount * 0.16, 0.14, 0.34);
        if (now - this.lastHelmTurnSoundAt > helmInterval) {
          this.audio.playHelmTurn(helmAmount);
          this.lastHelmTurnSoundAt = now;
        }
      }

      if (this.prevSailHeightForAudio !== null && this.prevSailAngleForAudio !== null) {
        const heightDelta = Math.abs(localShip.sailHeight - this.prevSailHeightForAudio);
        const angleDelta = Math.abs(angleWrap(localShip.sailAngle - this.prevSailAngleForAudio));
        if ((heightDelta > 0.055 || angleDelta > 0.18) && now - this.lastSailTrimSoundAt > 0.36) {
          this.audio.playSailTrim(THREE.MathUtils.clamp(heightDelta * 7 + angleDelta * 1.6, 0.35, 1.25));
          this.lastSailTrimSoundAt = now;
        }
      }
      this.prevSailHeightForAudio = localShip.sailHeight;
      this.prevSailAngleForAudio = localShip.sailAngle;
    } else {
      this.prevAnchored = null;
      this.prevAnchorRaiseProgress = null;
      this.prevSailHeightForAudio = null;
      this.prevSailAngleForAudio = null;
    }

    // Cannon launch — local player just got fired out of a ship cannon.
    if (player) {
      const ballisticNow = !!player.cannonBallistic;
      if (ballisticNow && !this.prevCannonBallistic) {
        this.audio.playCannonFire();
      }
      this.prevCannonBallistic = ballisticNow;
    }

    // Cutlass swing — when the active melee weapon enters its reload window we just swung.
    if (player && !player.atCannon && !player.atHelm && !player.atSails) {
      const active = player.weapons[player.activeSlot];
      const isMelee = active && WEAPONS[active.weaponId]?.melee;
      const reloading = !!(active && active.reloading);
      if (isMelee && reloading && !this.prevMeleeReloading) {
        this.audio.playCutlassSwing();
      }
      this.prevMeleeReloading = !!(isMelee && reloading);
    } else {
      this.prevMeleeReloading = false;
    }

    this.updateNavalAudioAndFx(dt, player, localShip);
  }

  /**
   * Round-3 naval audio + FX bed: world ambience (night/storm/shore), the sailing
   * bed for the ship you're aboard, the flooding loop for that ship (or the nearest
   * flooding hull within 20 m), bail scoop arcs, hull leaks, and the storm stinger.
   */
  private updateNavalAudioAndFx(_dt: number, player: Player | null, localShip: Ship | null) {
    if (!this.state) return;
    const t = this.ocean.getTime();
    const cam = this.renderer.camera.position;
    const atmo = this.renderer.getAtmosphere();
    const nightFactor = THREE.MathUtils.clamp(atmo.nightFactor, 0, 1);
    const storminess = THREE.MathUtils.clamp(this.stormWeatherIntensity, 0, 1);

    // Shore proximity — closest island edge to the listener drives breaker ambience.
    let nearestEdge = Infinity;
    for (const island of this.state.islands) {
      const edge = this.distance2D(cam.x, cam.z, island.position.x, island.position.z) - island.radius;
      if (edge < nearestEdge) nearestEdge = edge;
    }
    const nearShore01 = Number.isFinite(nearestEdge)
      ? THREE.MathUtils.clamp(1 - THREE.MathUtils.clamp(nearestEdge / 70, 0, 1), 0, 1)
      : 0;
    this.audio.setAmbience({ nightFactor, storminess, nearShore01 });

    // Sailing bed — reflects the ship the player is physically standing on.
    const aboardShip = player?.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
    if (aboardShip) {
      const stats = SHIP_STATS[aboardShip.type];
      const speed = Math.hypot(aboardShip.velocity.x, aboardShip.velocity.z);
      const speed01 = THREE.MathUtils.clamp(speed / Math.max(stats.maxSpeed, 0.001), 0, 1);
      const heel01 = THREE.MathUtils.clamp(Math.abs(aboardShip.roll ?? 0) / 0.3, 0, 1);
      const roughness01 = THREE.MathUtils.clamp(storminess * 0.8 + heel01 * 0.4, 0, 1);
      this.audio.setSailingState({ speed01, roughness01, heel01, luffing: !!aboardShip.luffing });
    } else {
      this.audio.setSailingState({ speed01: 0, roughness01: 0, heel01: 0, luffing: false });
    }

    // Flooding loop — the ship you're on if it's taking water, else the nearest
    // flooding hull within earshot.
    const floodShip = aboardShip && (aboardShip.waterLevel ?? 0) > 0.02
      ? aboardShip
      : this.findNearestFloodingShip(cam, 20);
    if (floodShip && (floodShip.waterLevel ?? 0) > 0.02) {
      const level = THREE.MathUtils.clamp(floodShip.waterLevel ?? 0, 0, 1);
      if (!this.floodingLoopActive) {
        this.audio.startFlooding(level);
        this.floodingLoopActive = true;
      } else {
        this.audio.updateFlooding(level);
      }
      if (t - this.lastHullLeakAt > 0.4) {
        this.emitHullLeaks(floodShip);
        // Pressure jets from holes punched below the waterline: the anchors
        // ride the lofted hull (heave/pitch/roll/list), +Z = outward normal.
        if (!floodShip.sinking) {
          for (const hole of this.shipRenderer.getHoleAnchors(floodShip.id)) {
            if (!hole.active || !hole.belowWaterline) continue;
            hole.anchor.getWorldPosition(this.tempRenderPos);
            hole.anchor.getWorldDirection(this.tempHudVector);
            this.combatFx.emitHullLeak(
              { x: this.tempRenderPos.x, y: this.tempRenderPos.y, z: this.tempRenderPos.z },
              this.tempHudVector.x * (0.7 + (floodShip.waterLevel ?? 0) * 0.9),
              this.tempHudVector.z * (0.7 + (floodShip.waterLevel ?? 0) * 0.9),
            );
          }
        }
        this.lastHullLeakAt = t;
      }
    } else if (this.floodingLoopActive) {
      this.audio.stopFlooding();
      this.floodingLoopActive = false;
    }

    // Bail scoop arcs (+ the local scoop one-shot), beaten out for all bailers.
    if (t - this.lastBailFxAt > 0.6) {
      this.lastBailFxAt = t;
      let localBailing = false;
      for (const bailer of this.state.players) {
        if (!bailer.bailing) continue;
        const bShip = bailer.onShipId ? this.shipsById.get(bailer.onShipId) ?? null : null;
        let dx = 1;
        let dz = 0;
        if (bShip) {
          dx = bailer.position.x - bShip.position.x;
          dz = bailer.position.z - bShip.position.z;
          const len = Math.hypot(dx, dz) || 1;
          dx /= len;
          dz /= len;
        }
        this.combatFx.emitBailScoop(
          { x: bailer.position.x + dx * 0.3, y: bailer.position.y + PLAYER.HEIGHT * 0.5, z: bailer.position.z + dz * 0.3 },
          dx, dz,
        );
        if (bailer.id === this.localPlayerId) localBailing = true;
      }
      if (localBailing) this.audio.playBail();
    }

    // Storm-shrink stinger on the rising edge.
    const shrinkingNow = !!this.state.storm.shrinking;
    if (shrinkingNow && !this.prevStormShrinking) this.audio.playStormShrink();
    this.prevStormShrinking = shrinkingNow;

    void localShip;
  }

  private findNearestFloodingShip(pos: THREE.Vector3, maxDist: number): Ship | null {
    if (!this.state) return null;
    let best: Ship | null = null;
    let bestDist = maxDist;
    for (const ship of this.state.ships) {
      if (!ship.alive || (ship.waterLevel ?? 0) <= 0.02) continue;
      const d = this.distance2D(pos.x, pos.z, ship.position.x, ship.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = ship;
      }
    }
    return best;
  }

  /** Streaming water at holed hull sections sitting near/below the waterline. */
  private emitHullLeaks(ship: Ship) {
    const stats = SHIP_STATS[ship.type];
    const sections: Array<[keyof Ship['hull'], number, number]> = [
      ['bow', 0, stats.length * 0.42],
      ['stern', 0, -stats.length * 0.42],
      ['port', -stats.width * 0.5, 0],
      ['starboard', stats.width * 0.5, 0],
    ];
    for (const [section, lx, lz] of sections) {
      if (ship.hull[section] > 0.55) continue;
      const point = this.getShipWorldPoint(ship, lx, lz, 0.16);
      this.combatFx.emitHullLeak(
        { x: point.x, y: point.y, z: point.z },
        point.x - ship.position.x,
        point.z - ship.position.z,
      );
    }
  }

  private setHull(fill: HTMLDivElement, label: HTMLElement, value: number) {
    const percent = Math.round(value * 100);
    fill.style.width = `${percent}%`;
    label.textContent = `${percent}%`;
  }

  /** Bilge water gauge — vertical ship-silhouette fill, trend arrow, red alarm > 75%.
   *  Visible only while the local player stands on a ship that's taking on water. */
  private updateWaterGauge(player: Player) {
    const ship = player.onShipId ? this.shipsById.get(player.onShipId) ?? null : null;
    const level = ship ? THREE.MathUtils.clamp(ship.waterLevel ?? 0, 0, 1) : 0;
    const show = !!ship
      && level > 0.02
      && player.state !== 'eliminated'
      && player.state !== 'respawning';
    this.ui.waterGauge.classList.toggle('visible', show);
    if (!show || !ship) {
      this.ui.waterGauge.classList.remove('danger');
      // Damp the ship-status widget tint back to normal when not flooding.
      this.ui.shipStatus.classList.remove('flooding', 'flooding-critical');
      return;
    }

    const pct = Math.round(level * 100);
    this.ui.waterGaugeFill.style.height = `${pct}%`;
    this.ui.waterGaugePct.textContent = `${pct}%`;
    const danger = level > 0.75;
    this.ui.waterGauge.classList.toggle('danger', danger);

    const rate = ship.floodingRate ?? 0;
    const trend = this.ui.waterGaugeTrend;
    if (rate > 0.0005) {
      trend.textContent = '▲';
      trend.style.color = danger ? '#ff8a6a' : '#ffb37a';
    } else if (rate < -0.0005) {
      trend.textContent = '▼';
      trend.style.color = '#7fe0a0';
    } else {
      trend.textContent = '▬';
      trend.style.color = '#9aa8b8';
    }

    // Tint the ship-status widget so the hull panel reads "flooding" at a glance.
    this.ui.shipStatus.classList.toggle('flooding', level > 0.02 && !danger);
    this.ui.shipStatus.classList.toggle('flooding-critical', danger);
  }

  private renderShipInventory(ship: Ship | null, player: Player) {
    const nearOwnShip = !!ship
      && player.shipId === ship.id
      && player.state === 'alive'
      && this.distance2D(player.position.x, player.position.z, ship.position.x, ship.position.z) < 58;
    const visible = !!ship
      && player.state !== 'swimming'
      && player.state !== 'eliminated'
      && player.state !== 'respawning'
      && (player.onShipId === ship.id || nearOwnShip);
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

  private getPocketWheelCount(player: Player, slot: number) {
    switch (slot) {
      case 0:
        return player.pocketBanana;
      case 1:
        return player.pocketWood;
      case 2:
        return player.pocketCoconut;
      case 3:
        return player.pocketMeat + player.pocketMango;
      default:
        return 0;
    }
  }

  private getPocketWheelKind(player: Player | null, slot: number): PocketPreviewKind | null {
    switch (slot) {
      case 0:
        return 'banana';
      case 1:
        return 'wood';
      case 2:
        return 'coconut';
      case 3:
        return (player?.pocketMeat ?? 0) > 0 ? 'meat' : 'mango';
      default:
        return null;
    }
  }

  private updateSupplyWheelCounts(player: Player) {
    const counts = [player.pocketBanana, player.pocketWood, player.pocketCoconut, player.pocketMeat + player.pocketMango];
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
    const kind = this.getPocketWheelKind(this.getLocalPlayer(), slot);
    if (!kind) return;
    const player = this.getLocalPlayer();
    if (player?.carryingChestId) return;
    if (player && player.pocketUseCooldown > 0) return;
    if (this.pocketUsePreviewTimer > 0) return;
    if (!player || this.getPocketWheelCount(player, slot) <= 0) return;
    this.pocketUsePreviewKind = kind;
    this.pocketUsePreviewTimer = kind === 'wood' ? 0.45 : 0.82;
  }

  private goldLeaderboardSignature = '';
  private renderGoldLeaderboard(localPlayerId: string) {
    if (!this.state) return;
    const ranked = this.state.players
      .filter((p) => p.state !== 'eliminated')
      .slice()
      .sort((a, b) => b.gold - a.gold)
      .slice(0, 3);
    const signature = `${localPlayerId}:${ranked.map((p) => `${p.id}:${p.gold}`).join('|')}`;
    if (signature === this.goldLeaderboardSignature) return;
    this.goldLeaderboardSignature = signature;
    if (!ranked.length) {
      this.ui.goldLeaders.innerHTML = '';
      return;
    }
    this.ui.goldLeaders.innerHTML = ranked
      .map((p, index) => {
        const isSelf = p.id === localPlayerId;
        const safeName = (p.name || 'Pirate').replace(/[<>&"]/g, (c) =>
          c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;',
        );
        return `<div class="leader-row" data-rank="${index + 1}" data-self="${isSelf ? 1 : 0}">
          <span class="leader-rank">${index + 1}</span>
          <span class="leader-name">${safeName}</span>
          <span class="leader-amt">${p.gold}</span>
        </div>`;
      })
      .join('');
  }

  private renderShipUpgrades(ship: Ship | null) {
    if (!ship) {
      if (this.shipUpgradeSignature !== '') {
        this.ui.shipUpgrades.innerHTML = '';
        this.shipUpgradeSignature = '';
      }
      return;
    }

    const baseStats = SHIP_STATS[ship.type];
    const hasHull = ship.upgrades.some((u) => u.type === 'hull_reinforcement');
    const hasCannons = ship.upgrades.some((u) => u.type === 'charged_cannons');
    const hasSails = ship.upgrades.some((u) => u.type === 'swift_sails');

    const cannonBaseDmg = SHIP.CANNON_DAMAGE_HULL;
    const cannonDmg = Math.round(cannonBaseDmg * (hasCannons ? SHIP_UPGRADES.CANNON_DAMAGE_MULT : 1));
    const sailSpeed = (baseStats.maxSpeed * (hasSails ? SHIP_UPGRADES.SWIFT_SPEED_MULT : 1)).toFixed(1);

    const signature = [
      ship.id,
      ship.maxHull,
      hasHull ? 1 : 0,
      hasCannons ? 1 : 0,
      hasSails ? 1 : 0,
    ].join(':');
    if (signature === this.shipUpgradeSignature) return;
    this.shipUpgradeSignature = signature;

    const statRow = `
      <div class="ship-stat-row">
        <span class="ship-stat" data-stat="hull"${hasHull ? ' data-upgraded="1"' : ''}>
          <span class="ship-stat-icon">🛡</span>
          <span class="ship-stat-label">Max Hull</span>
          <span class="ship-stat-value">${ship.maxHull}${hasHull ? ` <em>(+${Math.round((SHIP_UPGRADES.HULL_HP_MULT - 1) * 100)}%)</em>` : ''}</span>
        </span>
        <span class="ship-stat" data-stat="cannons"${hasCannons ? ' data-upgraded="1"' : ''}>
          <span class="ship-stat-icon">✹</span>
          <span class="ship-stat-label">Cannon Dmg</span>
          <span class="ship-stat-value">${cannonDmg}${hasCannons ? ` <em>(+${Math.round((SHIP_UPGRADES.CANNON_DAMAGE_MULT - 1) * 100)}%)</em>` : ''}</span>
        </span>
        <span class="ship-stat" data-stat="sails"${hasSails ? ' data-upgraded="1"' : ''}>
          <span class="ship-stat-icon">✦</span>
          <span class="ship-stat-label">Top Speed</span>
          <span class="ship-stat-value">${sailSpeed}<span class="ship-stat-unit">kn</span>${hasSails ? ` <em>(+${Math.round((SHIP_UPGRADES.SWIFT_SPEED_MULT - 1) * 100)}%)</em>` : ''}</span>
        </span>
      </div>
    `;

    const pills = ship.upgrades.length === 0
      ? ''
      : `<div class="ship-upgrade-pills">${ship.upgrades.map((upgrade) => {
          const meta = this.getUpgradePresentation(upgrade.type);
          return `<span class="upgrade-pill" data-type="${upgrade.type}" title="${meta.name}: ${meta.effect}">${meta.icon} ${meta.short} <em>${meta.effect}</em></span>`;
        }).join('')}</div>`;

    this.ui.shipUpgrades.innerHTML = statRow + pills;
  }

  private renderKegStatus(player: Player) {
    const hidden = player.state === 'eliminated' || player.state === 'respawning';
    this.ui.kegStatus.classList.toggle('visible', !hidden);
    this.ui.kegStatusValue.textContent = this.getKegSummary(player);
  }

  private getKegSummary(player: Player) {
    const normal = player.kegs <= 0
      ? 'None remaining'
      : player.kegCooldown > 0
        ? `${Math.max(1, Math.ceil(player.kegCooldown))}s until second keg`
        : player.kegs === 1 ? '1 ready' : `${player.kegs} ready`;
    return player.megaKegs > 0 ? `Mega ${player.megaKegs} ready · ${normal}` : normal;
  }

  private getSpecialSummary(player: Player) {
    const parts: string[] = [];
    if (player.superCannonballs > 0) parts.push(`Super cannonball x${player.superCannonballs} (use cannonball at cannon)`);
    if (player.megaKegs > 0) parts.push(`Mega keg x${player.megaKegs} (hold G, click/place)`);
    if (player.tsunamiCharges > 0) parts.push(`Tsunami x${player.tsunamiCharges} [E]`);
    if (parts.length > 0) return `Powers READY: ${parts.join(' · ')}`;

    const next = player.playerKillStreak < 5
      ? { count: 5, reward: 'super cannonball' }
      : player.playerKillStreak < 10
        ? { count: 10, reward: 'mega keg' }
        : player.playerKillStreak < 20
          ? { count: 20, reward: 'tsunami' }
          : null;
    return next
      ? `Powers: streak ${player.playerKillStreak}/${next.count} for ${next.reward} (5 super cannonball, 10 mega keg, 20 tsunami)`
      : `Powers: streak ${player.playerKillStreak} · all rewards unlocked at 5/10/20`;
  }

  private getObjectiveSummary(
    player: Player,
    ship: Ship | null,
    context: {
      chestsInHold: number;
      mappedIsland: Island | null;
      closestHoarder: { npc: IslandNpc; island: Island; distance: number } | null;
      outsideStorm: boolean;
      shipCritical: boolean;
      shipOnFire: boolean;
    },
  ) {
    if (context.outsideStorm) return 'Objective: sail inside the storm circle';
    if (context.shipCritical) return 'Objective: repair hull before the ship goes down';
    if (context.shipOnFire) return 'Objective: douse fire at the repair point';
    if (player.carryingChestId && context.closestHoarder) {
      return `Objective: sell chest at ${context.closestHoarder.island.name}`;
    }
    if (context.chestsInHold > 0 && context.closestHoarder) {
      return `Objective: deliver ${context.chestsInHold} chest${context.chestsInHold === 1 ? '' : 's'} to ${context.closestHoarder.island.name}`;
    }
    if (context.mappedIsland) return `Objective: dig Gold Hoarder chests on ${context.mappedIsland.name}`;
    if (player.gold >= ECONOMY.GOLD_WIN_TARGET * 0.72) return 'Objective: protect your lead and finish the gold run';
    if (ship && ship.upgrades.length < 2) return 'Objective: claim upgrades, raid ships, and sell treasure';
    return 'Objective: raid ships, sell treasure, and stay ahead of the storm';
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
    const host = window.location.hostname;
    const port = window.location.port;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
    // Any localhost port other than the game server's own (8080) is a dev server (Vite, etc.).
    // Connect directly to 8080 instead of relying on a proxy — works for 3000/3003/5173/etc.
    if (isLocalhost && port && port !== '8080') {
      return `${protocol}://${host}:8080/ws`;
    }
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
    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    if (!activeWeapon || activeWeapon.weaponId !== 'cutlass' || !activeWeapon.reloading) {
      return 0;
    }
    const cooldown = activeWeapon.reloadTimer > WEAPONS.cutlass.reloadTime
      ? CUTLASS_VIEW_LUNGE_COOLDOWN
      : WEAPONS.cutlass.reloadTime;
    return 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / cooldown, 0, 1);
  }

  private syncHeldWeapon(mesh: THREE.Group, player: Player) {
    const rightHand = mesh.getObjectByName('right-hand');
    if (!rightHand) return;

    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
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
          if (player.blocking) {
            weaponMesh.position.set(0.0, 0.1, 0.2);
            weaponMesh.rotation.set(-0.82, -0.08, -0.18);
            break;
          }
          const charge = THREE.MathUtils.clamp(player.cutlassCharge ?? 0, 0, 1);
          if (charge > 0.01) {
            weaponMesh.position.set(
              0.02 - charge * 0.08,
              0.04 + charge * 0.09,
              0.12 - charge * 0.08,
            );
            weaponMesh.rotation.set(
              -0.1 - charge * 0.72,
              0.1 - charge * 0.18,
              -0.68 - charge * 0.5,
            );
            break;
          }
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
    if (player.atCannon || player.atHelm || player.atSails) {
      this.localViewPocketRoot.visible = false;
      this.localViewPocketKind = null;
      return false;
    }
    // Carrying a treasure chest takes over both hands — nothing else can be held.
    if (player.carryingChestId) {
      const kind: PocketPreviewKind = 'chest';
      let mesh = this.localViewPocketRoot.getObjectByName('local-pocket') as THREE.Group | null;
      if (!mesh || this.localViewPocketKind !== kind) {
        this.localViewPocketRoot.clear();
        mesh = makePocketPreviewMesh(kind);
        mesh.name = 'local-pocket';
        mesh.rotation.y = Math.PI;
        mesh.scale.setScalar(1.0);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      const time = this.ocean.getTime();
      const moveAxes = this.input.getMoveAxes();
      const moveAmount = Math.min(1, Math.hypot(moveAxes.x, moveAxes.z));
      const trudge = Math.sin(time * (3.6 + moveAmount * 1.8)) * (0.012 + moveAmount * 0.02);
      const sway = Math.sin(time * (1.9 + moveAmount * 0.9)) * (0.008 + moveAmount * 0.012);
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(0 + sway * 0.4, -0.34 + trudge, -0.55);
      this.localViewPocketRoot.rotation.set(-0.18 + trudge * 0.5, 0 + sway * 0.18, 0);
      return true;
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
        mesh.scale.setScalar(2.0);
        applyViewmodelMaterialSettings(mesh);
        this.localViewPocketRoot.add(mesh);
        this.localViewPocketKind = kind;
      }
      // Two-beat dig cycle: lift the shovel, then drive it into the dirt.
      const time = this.ocean.getTime();
      const cycle = (time * 1.9) % 1;
      const lift = Math.sin(cycle * Math.PI) ** 2;            // 0 → 1 → 0 (raise)
      const strike = Math.max(0, Math.sin((cycle - 0.5) * Math.PI * 2)); // sharp drop
      this.localViewPocketRoot.visible = true;
      this.localViewPocketRoot.position.set(
        -0.05,
        -0.34 + lift * 0.22 - strike * 0.12,
        -0.55 + lift * 0.05 - strike * 0.08,
      );
      this.localViewPocketRoot.rotation.set(
        -0.55 - lift * 0.55 + strike * 0.85,
        0.12 + lift * 0.18,
        -0.08 + strike * 0.05,
      );
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
    const kind = usingPreview ? this.pocketUsePreviewKind! : this.getPocketWheelKind(player, slot!);
    if (!kind || (!usingPreview && this.getPocketWheelCount(player, slot!) <= 0)) {
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
      this.localCutlassCharge = 0;
      return;
    }

    const player = this.getLocalPlayer();
    const activeWeapon = player?.atCannon || player?.atHelm || player?.atSails ? null : player?.weapons[player.activeSlot] ?? null;
    if (!player || !activeWeapon || activeWeapon.weaponId === 'ship_cannon' || player.state === 'eliminated' || player.state === 'respawning') {
      this.localViewWeaponRoot.visible = false;
      this.localViewWeaponAmmoSignature = '';
      this.localViewWeaponKick = 0;
      this.localViewWeaponReloadPhase = 0;
      this.localCutlassCharge = 0;
      return;
    }
    const weaponId = activeWeapon.weaponId;

    let weaponMesh = this.localViewWeaponRoot.getObjectByName('local-view-weapon') as THREE.Group | null;
    if (!weaponMesh || this.localViewWeaponId !== weaponId) {
      this.localViewWeaponRoot.clear();
      weaponMesh = makeHeldWeaponMesh(weaponId);
      weaponMesh.name = 'local-view-weapon';
      weaponMesh.rotation.y = Math.PI;
      weaponMesh.scale.setScalar(
        weaponId === 'eye_of_reach'
          ? 0.92
          : weaponId === 'blunderbuss'
            ? 0.95
            : 1.2,
      );
      applyViewmodelMaterialSettings(weaponMesh);
      this.localViewWeaponRoot.add(weaponMesh);
      this.localViewWeaponId = weaponId;
    }

    const firearmEquipped = !WEAPONS[weaponId].melee;
    const cutlassEquipped = weaponId === 'cutlass';
    const cutlassBlocking = cutlassEquipped && this.input.isAiming() && !this.input.isFiring() && !activeWeapon.reloading;
    const cutlassCharging = cutlassEquipped && this.input.isFiring() && !cutlassBlocking && !activeWeapon.reloading;
    if (cutlassCharging) {
      this.localCutlassCharge = Math.min(1, this.localCutlassCharge + this.frameDt / CUTLASS_VIEW_CHARGE_TIME);
    } else {
      this.localCutlassCharge += (0 - this.localCutlassCharge) * Math.min(1, this.frameDt * (activeWeapon.reloading ? 14 : 8));
    }
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
    // Muzzle flash + smoke + recoil the instant you pull the trigger
    // (client-predicted press edge), so feedback is immediate rather than
    // waiting on the server ammo round-trip. Gated on a loaded, ready weapon.
    const firingNow = firearmEquipped && this.input.isFiring();
    const canFire = activeWeapon.ammo > 0 && !activeWeapon.reloading;
    if (firingNow && canFire && !this.prevLocalFiring) {
      this.triggerMuzzleFlash(weaponId);
      this.localViewWeaponKick = Math.min(1.35, this.localViewWeaponKick + 0.55);
    }
    this.prevLocalFiring = firingNow;
    const kickTarget = firearmEquipped && this.input.isFiring() && !activeWeapon.reloading ? 0.72 : 0;
    this.localViewWeaponKick += (kickTarget - this.localViewWeaponKick) * Math.min(1, this.frameDt * (kickTarget > this.localViewWeaponKick ? 18 : 13));
    const reloadBlend = activeWeapon.reloading && firearmEquipped
      ? 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / Math.max(0.001, WEAPONS[weaponId].reloadTime), 0, 1)
      : 0;
    if (activeWeapon.reloading && firearmEquipped) {
      this.localViewWeaponReloadPhase = reloadBlend;
    } else {
      this.localViewWeaponReloadPhase += (0 - this.localViewWeaponReloadPhase) * Math.min(1, this.frameDt * 10);
    }
    const reloadArc = Math.sin(this.localViewWeaponReloadPhase * Math.PI);
    const recoilBack = this.localViewWeaponKick * 0.12;
    const recoilLift = this.localViewWeaponKick * 0.045;
    const recoilRoll = this.localViewWeaponKick * 0.055;

    // A raised spyglass (hold P) occupies both hands — stow the weapon.
    this.localViewWeaponRoot.visible = !this.spyglassActive;

    switch (weaponId) {
      case 'eye_of_reach':
        // Brought up/in/closer for real screen presence (was a tiny stick in
        // the far corner); ADS still swings it to center-scope.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.32, 0.025, aimBlend) + sway * 0.26 + travelSwing * 0.18 + reloadArc * 0.06,
          THREE.MathUtils.lerp(-0.3, -0.15, aimBlend) + bob * 0.75 - recoilLift - reloadArc * 0.04,
          THREE.MathUtils.lerp(-0.8, -0.42, aimBlend) - recoilBack * 0.72 + reloadArc * 0.06,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.26 + aimBlend * 0.0 - recoilLift * 1.1 + reloadArc * 0.18,
          -0.24 + aimBlend * 0.19 - reloadArc * 0.22,
          -0.1 - strafeTilt * 0.8 - recoilRoll + reloadArc * 0.1,
        );
        break;
      case 'blunderbuss':
        // Lower-right hip with real screen PRESENCE (reads as a gun) without
        // parking the fat stock over center; barrel angled toward the
        // crosshair so the muzzle flash lands in the visible lower third.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.34, 0.16, aimBlend) + sway * 0.36 + travelSwing * 0.28 + reloadArc * 0.08,
          THREE.MathUtils.lerp(-0.28, -0.24, aimBlend) + bob - recoilLift * 0.8 - reloadArc * 0.06,
          THREE.MathUtils.lerp(-0.82, -0.7, aimBlend) - recoilBack * 0.72 + reloadArc * 0.1,
        );
        this.localViewWeaponRoot.rotation.set(
          -0.24 - aimBlend * 0.07 - recoilLift + reloadArc * 0.28,
          -0.18 + aimBlend * 0.12 - reloadArc * 0.34,
          -0.08 - strafeTilt - recoilRoll * 0.8 + reloadArc * 0.14,
        );
        break;
      case 'cutlass':
        {
          const cooldownProgress = activeWeapon.reloading
            ? 1 - THREE.MathUtils.clamp(activeWeapon.reloadTimer / CUTLASS_VIEW_LUNGE_COOLDOWN, 0, 1)
            : 0;
          const slashArc = Math.sin(THREE.MathUtils.clamp((cooldownProgress - 0.08) / 0.58, 0, 1) * Math.PI);
          const lungePush = THREE.MathUtils.smoothstep(cooldownProgress, 0.06, 0.34)
            * (1 - THREE.MathUtils.smoothstep(cooldownProgress, 0.52, 1));
          const charge = this.localCutlassCharge;
          const chargeReadyPulse = charge > 0.96 ? Math.sin(time * 22) * 0.018 : 0;
          if (cutlassBlocking) {
            this.localViewWeaponRoot.position.set(
              0.16 + sway * 0.14,
              -0.18 + bob * 0.45,
              -0.48 + travelSwing * 0.08,
            );
            this.localViewWeaponRoot.rotation.set(
              -0.92,
              -0.08,
              -0.18 - strafeTilt * 0.8,
            );
          } else {
            this.localViewWeaponRoot.position.set(
              0.31 - charge * 0.16 + slashArc * 0.1 + sway * 0.24 + travelSwing * 0.42,
              -0.3 + charge * 0.1 + chargeReadyPulse + bob * 0.75 - slashArc * 0.08,
              -0.58 - charge * 0.22 + lungePush * 0.18,
            );
            this.localViewWeaponRoot.rotation.set(
              -0.02 - charge * 0.58 + slashArc * 0.54,
              -0.28 - charge * 0.22 - slashArc * 0.2,
              -0.82 - charge * 0.62 - strafeTilt * 1.4 - slashArc * 1.02,
            );
          }
        }
        break;
      default:
        // Flintknock + fallback: readable lower-right presence, barrel angled
        // toward the crosshair so the muzzle flash lands on screen.
        this.localViewWeaponRoot.position.set(
          THREE.MathUtils.lerp(0.26, 0.085, aimBlend) + sway * 0.64 + travelSwing * 0.38 + reloadArc * 0.07,
          THREE.MathUtils.lerp(-0.22, -0.17, aimBlend) + bob - recoilLift * 0.62 - reloadArc * 0.05,
          THREE.MathUtils.lerp(-0.52, -0.4, aimBlend) - recoilBack * 0.8 + reloadArc * 0.06,
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
        // Counter-scale against the LIVE camera fov (not the target constant)
        // so the viewmodel keeps its apparent size through the zoom lerp and
        // under any non-74 base fov (swimming 78, aiming 64, settings).
        const hipHalf = THREE.MathUtils.degToRad(HIP_FOV * 0.5);
        const liveHalf = THREE.MathUtils.degToRad(Math.max(adsFov * 0.85, this.renderer.camera.fov) * 0.5);
        this.localViewWeaponRoot.scale.setScalar(Math.tan(liveHalf) / Math.tan(hipHalf));
      } else {
        // Hip viewmodels at 82%: guns should frame the fight, not block it.
        this.localViewWeaponRoot.scale.setScalar(0.82);
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

    // Downed crewmate nearby → hold to revive (server drains reviveProgress).
    if (this.state && player.state === 'alive' && player.shipId) {
      for (const other of this.state.players) {
        if (other.id === player.id || other.state !== 'downed') continue;
        if (other.shipId !== player.shipId) continue;
        const d2 = this.distance2D(player.position.x, player.position.z, other.position.x, other.position.z);
        if (d2 > 3.2 || Math.abs(other.position.y - player.position.y) > 2.2) continue;
        this.pushInteractionCandidate(
          candidates,
          player,
          new THREE.Vector3(other.position.x, other.position.y + 0.5, other.position.z),
          3.4,
          0.1,
          `[X] Revive ${other.name}`,
          'Hold to stabilize your crewmate',
          'revive',
        );
      }
    }

    const mermaidShip = this.getMermaidReturnShip(player);
    if (mermaidShip) {
      if (!this.mermaidAnchor || this.mermaidAnchor.shipId !== mermaidShip.id) {
        this.mermaidAnchor = this.createMermaidAnchor(player, mermaidShip);
      }
      this.pushInteractionCandidate(
        candidates,
        player,
        new THREE.Vector3(this.mermaidAnchor.x, player.position.y + 0.65, this.mermaidAnchor.z),
        6.4,
        0.12,
        '[X] Return To Ship',
        'Mermaid ferry waiting nearby',
        'mermaid',
      );
    }

    if (player.nearBarrelId) {
      const barrelPos = this.getBarrelWorldPoint(player.nearBarrelId);
      if (barrelPos) {
        const browsingThisBarrel = this.barrelBrowse?.barrelId === player.nearBarrelId;
        this.pushInteractionCandidate(
          candidates,
          player,
          barrelPos,
          5.5,
          0.72,
          browsingThisBarrel ? '[X] Take All' : '[X] Open Barrel',
          browsingThisBarrel ? 'Transfer supplies' : 'Island supplies',
          'barrel',
        );
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
          : `Base ${chest.value} gold · Gold Hoarder pays more`;
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

    const nearbyKeg = this.findNearbyKeg(player, ship ?? null);
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

    if (ship) {
      // Bail the bilge — available anywhere on deck when the hull is taking water.
      // Lowest priority (fixed score below every look-based candidate) so cannons,
      // the helm, repairs, etc. always win when you're actually facing one.
      if (player.onShipId === ship.id && (ship.waterLevel ?? 0) > 0.02) {
        const pct = Math.round((ship.waterLevel ?? 0) * 100);
        candidates.push({
          prompt: '[Hold X] Bail Water',
          label: `Bilge flooding ${pct}% · scoop it overboard`,
          score: -0.5,
          kind: 'bail',
        });
      }

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
        this.pushInteractionCandidate(candidates, player, helmPoint, 4.2, 0.2, '[X] Take Helm', 'A/D or arrows turn · W/S trims sails', 'helm');
      }

      if (this.isNearSailStation(player, ship)) {
        const ropeStations = getSailRopeStationLocals(SHIP_STATS[ship.type]);
        const localHere = this.toShipLocal(player, ship);
        const sailControl = ropeStations.reduce((best, st) =>
          Math.hypot(localHere.x - st.x, localHere.z - st.z) < Math.hypot(localHere.x - best.x, localHere.z - best.z) ? st : best);
        const sailPoint = this.getShipWorldPoint(ship, sailControl.x, sailControl.z, SHIP_STATS[ship.type].height + 0.85);
        const sailPct = Math.round(ship.sailHeight * 100);
        const canvasTorn = ship.sailIntegrity < 0.995;
        const sailPrompt = canvasTorn
          ? `[X] Hold — Mend the Rigging (${Math.round(ship.sailIntegrity * 100)}%)`
          : ship.sailHeight < 0.5
            ? `[X] Hold — Drop the Sails (${sailPct}%)`
            : `[X] Hold — Raise the Sails (${sailPct}%)`;
        this.pushInteractionCandidate(
          candidates,
          player,
          sailPoint,
          4.2,
          0.08,
          sailPrompt,
          canvasTorn ? 'Needs planks aboard · crewmates on the rope haul faster' : 'Crewmates on the rope haul faster',
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
          '[X] Climb Crow\'s Nest',
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
          4.4,
          0.18,
          ship.anchored ? `[X] Hold — Raise the Anchor (${anchorProgress}%)` : '[X] Drop the Anchor',
          ship.anchored ? 'Man the capstan · crewmates speed the turn' : 'Stops the ship fast — you will have to crank it back up',
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
        const cannonLocal = this.getCannonDeckLocalPosition(SHIP_STATS[ship.type], nearbyCannon);
        const cannonPoint = this.getShipWorldPoint(
          ship,
          cannonLocal.x,
          cannonLocal.z,
          SHIP_STATS[ship.type].height + 0.75,
        );
        this.pushInteractionCandidate(
          candidates,
          player,
          cannonPoint,
          4.8,
          0.16,
          '[X] Use Cannon',
          `Broadside cannon ${nearbyCannon + 1} · [5/6/7] ammo`,
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

  private findNearbyKeg(player: Player, ship: Ship | null = null): ShipKeg | null {
    if (!this.state) return null;
    let closest: ShipKeg | null = null;
    let closestDistance: number = SHIP.KEG_DIFFUSE_RANGE;
    for (const keg of this.state.kegs) {
      if (ship && keg.shipId && keg.shipId !== ship.id) continue;
      if (keg.timer <= 0) continue;
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
    const activeWeapon = player.atCannon || player.atHelm || player.atSails ? null : player.weapons[player.activeSlot];
    const cutlassReady = activeWeapon?.weaponId === 'cutlass';
    const cutlassSwing = cutlassReady ? this.getCutlassSwingProgress(player) : 0;
    const cutlassCharge = cutlassReady ? THREE.MathUtils.clamp(player.cutlassCharge ?? 0, 0, 1) : 0;
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
    } else if (cutlassReady && player.blocking) {
      torso.rotation.x = 0.12;
      torso.rotation.y = -0.08;
      pelvis.rotation.y = 0.04;
      leftArmPivot.rotation.set(-0.42, 0.22, 0.34);
      rightArmPivot.rotation.set(-0.88, -0.1, -0.28);
      leftLegPivot.rotation.set(-walkSwing * 0.72, 0, -0.06);
      rightLegPivot.rotation.set(walkSwing * 0.72, 0, 0.06);
      torso.rotation.z = -walkSwing * 0.035;
    } else if (cutlassReady) {
      torso.rotation.x = 0.08;
      torso.rotation.y = -0.14 - cutlassCharge * 0.24;
      pelvis.rotation.y = 0.08 + cutlassCharge * 0.12;
      leftArmPivot.rotation.set(0.08 + walkSwing * 0.45 - cutlassCharge * 0.22, 0.08 + cutlassCharge * 0.22, 0.24);
      rightArmPivot.rotation.set(-0.42 - walkSwing * 0.18 - cutlassCharge * 0.82, -0.16 - cutlassCharge * 0.24, -0.38 - cutlassCharge * 0.35);
      leftLegPivot.rotation.set(-walkSwing * 1.05, 0, -0.04);
      rightLegPivot.rotation.set(walkSwing * 1.05, 0, 0.04);
      torso.rotation.z = -walkSwing * 0.06 - cutlassCharge * 0.1;
    } else {
      const armRest = 0.2;
      leftArmPivot.rotation.set(armRest + walkSwing, 0, -0.12);
      rightArmPivot.rotation.set(armRest - walkSwing, 0, 0.12);
      leftLegPivot.rotation.set(-walkSwing * 1.15, 0, 0);
      rightLegPivot.rotation.set(walkSwing * 1.15, 0, 0);
      torso.rotation.z = walkSwing * 0.08;
    }

    if (cutlassReady && !player.blocking && player.state !== 'swimming' && !player.atHelm && !player.atCannon && !player.atSails) {
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
    const count = this.renderer.getQuality() === 'low' ? 0 : this.renderer.getQuality() === 'balanced' ? 4 : 8;
    if (count === 0) {
      this.windWisps.visible = false;
      return;
    }
    for (let index = 0; index < count; index++) {
      const material = new THREE.MeshBasicMaterial({
        map: this.windWispTexture,
        color: 0xe5f7ff,
        transparent: true,
        opacity: 0.032 + Math.random() * 0.025,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.windWisps.add(mesh);
      this.windWispMeshes.push({
        mesh,
        radius: 1.2 + Math.random() * 4.8,
        height: 0.18 + Math.random() * 1.7,
        phase: Math.random(),
        speed: 0.16 + Math.random() * 0.18,
        sway: (Math.random() - 0.5) * 1.8,
        tilt: (Math.random() - 0.5) * 0.08,
      });
    }
  }

  private updateWindWisps() {
    if (this.windWispMeshes.length === 0) {
      this.windWisps.visible = false;
      return;
    }
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
      const alpha = (0.028 + wind.strength * 0.052) * (1 - Math.abs(cycle - 0.5) * 1.05);
      (wisp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0.01, alpha);
    }
  }

  private toShipLocal(player: Player, ship: Ship) {
    return toShipLocalPoint(player.position, ship);
  }

  private isNearHelm(player: Player, ship: Ship) {
    return isSharedNearHelm(player, ship);
  }

  private isNearSailStation(player: Player, ship: Ship) {
    return isSharedNearSailStation(player, ship);
  }

  private isNearCrowNestLadder(player: Player, ship: Ship): boolean {
    return isSharedNearCrowNestLadder(player, ship);
  }

  private isNearAnchor(player: Player, ship: Ship) {
    return isSharedNearAnchor(player, ship);
  }

  private getAnchorControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return getSharedAnchorControlLocal(stats);
  }

  private getSailControlLocal(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]) {
    return getSharedSailControlLocal(stats);
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
    return findSharedNearbyCannonIndex(player, ship);
  }

  private getCannonDeckLocalPosition(
    stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS],
    cannonIndex: number,
  ): { x: number; z: number } {
    return getSharedCannonDeckLocalPosition(stats, cannonIndex);
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
      // Sit ABOVE the bottom HUD stack (pocket/stores bars) and on a higher
      // z-index so NPC dialogue is never rendered behind the panels.
      'bottom:20vh',
      'z-index:140',
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
    if (!player) return 0;
    const dist = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ);

    const safeRadius = Math.max(1, this.state.storm.safeRadius);
    const phase = this.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);
    const phaseBoost = Math.min(1, phase / maxPhase) * 0.2;
    const shrinkBoost = this.state.storm.shrinking ? 0.08 + this.state.storm.shrinkProgress * 0.08 : 0;

    // Crossfade across a ±30m band at the wall — weather used to snap from
    // 0.24 to 0.52+ the frame you crossed the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -30, 30);
    const stormDepth = THREE.MathUtils.clamp(distOutside / 240, 0, 1);
    const edgeFade = THREE.MathUtils.clamp((dist / safeRadius - 0.84) / 0.16, 0, 1);
    const insideIntensity = Math.min(0.24, edgeFade * 0.14 + shrinkBoost * 0.45);
    const outsideIntensity = Math.min(1, 0.52 + phaseBoost + shrinkBoost + stormDepth * 0.32);
    return THREE.MathUtils.lerp(insideIntensity, outsideIntensity, outsideBlend);
  }

  private computeStormRainIntensity(): number {
    if (!this.state) return 0;
    const player = this.getLocalPlayer();
    if (!player) return 0;

    const dist = this.distance2D(player.position.x, player.position.z, this.state.storm.centerX, this.state.storm.centerZ);
    const safeRadius = Math.max(1, this.state.storm.safeRadius);
    const phase = this.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);

    // Rain builds across the wall band instead of popping on at the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -25, 35);
    if (outsideBlend <= 0.001) return 0;
    const stormDepth = THREE.MathUtils.clamp(distOutside / 220, 0, 1);
    const shrinkBoost = this.state.storm.shrinking ? 0.08 : 0;
    return Math.min(1, 0.34 + stormDepth * 0.42 + (phase / maxPhase) * 0.2 + shrinkBoost) * outsideBlend;
  }

  /** World-space rain: wind-blown line-segment drops falling around the
   *  camera (replaces the old screen-space canvas overlay — rain now exists
   *  in the world, slants with the wind, and reads correctly in motion). */
  private rain3D: {
    lines: THREE.LineSegments;
    material: THREE.LineBasicMaterial;
    geo: THREE.BufferGeometry;
    pos: Float32Array;
    drops: number;
  } | null = null;

  private ensureRain3D() {
    if (this.rain3D) return this.rain3D;
    const drops = 1600;
    const pos = new Float32Array(drops * 2 * 3);
    // Seed deterministically around the origin; first update recenters on camera.
    for (let i = 0; i < drops; i++) {
      const o = i * 6;
      const a = (i * 2.399963) % (Math.PI * 2); // golden-angle spiral: even disc coverage
      const rad = 30 * Math.sqrt(((i * 7919) % 1000) / 1000);
      pos[o] = Math.cos(a) * rad;
      pos[o + 1] = ((i * 37) % 240) / 10 - 4;
      pos[o + 2] = Math.sin(a) * rad;
      pos[o + 3] = pos[o];
      pos[o + 4] = pos[o + 1] - 0.5;
      pos[o + 5] = pos[o + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.LineBasicMaterial({
      color: 0xcfe0f4,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, material);
    lines.frustumCulled = false;
    lines.renderOrder = 8;
    lines.visible = false;
    this.renderer.scene.add(lines);
    this.rain3D = { lines, material, geo, pos, drops };
    return this.rain3D;
  }

  private updateStormRain3D(dt: number, intensity: number) {
    // Clear the legacy canvas overlay once (kept in the DOM for compatibility).
    if (this.stormRainCanvas && this.stormRainCtx && this.stormRainCanvas.width > 0) {
      this.stormRainCtx.clearRect(0, 0, this.stormRainCanvas.width, this.stormRainCanvas.height);
      this.stormRainCanvas.width = 0;
    }
    if (intensity <= 0.001) {
      if (this.rain3D) this.rain3D.lines.visible = false;
      return;
    }
    const rain = this.ensureRain3D();
    rain.lines.visible = true;
    const cam = this.renderer.camera.position;
    const t = this.ocean.getTime();
    const wind = sampleWind(t);
    const gust = Math.sin(t * 2.7) * 0.5 + Math.sin(t * 6.3 + 1.4) * 0.3;
    const windSpeed = (6 + intensity * 12) * wind.strength + gust * intensity * 3;
    const windX = Math.sin(wind.direction) * windSpeed;
    const windZ = Math.cos(wind.direction) * windSpeed;
    const fallSpeed = 21 + intensity * 11;
    const active = Math.max(24, Math.floor(rain.drops * (0.22 + intensity * 0.78)));
    const streak = 0.55 + intensity * 0.8;
    // Normalized fall direction × streak length for the trailing vertex.
    const vLen = Math.hypot(windX, windZ, fallSpeed);
    const sx = (windX / vLen) * streak;
    const sy = (fallSpeed / vLen) * streak;
    const sz = (windZ / vLen) * streak;
    const pos = rain.pos;
    const spawnRadius = 32;
    for (let i = 0; i < active; i++) {
      const o = i * 6;
      let x = pos[o] + windX * dt * 0.85;
      let y = pos[o + 1] - fallSpeed * dt;
      let z = pos[o + 2] + windZ * dt * 0.85;
      // Recycle drops that fell below the camera or drifted out of the volume.
      const dx = x - cam.x;
      const dz = z - cam.z;
      if (y < cam.y - 8 || dx * dx + dz * dz > spawnRadius * spawnRadius * 1.9) {
        const a = Math.random() * Math.PI * 2;
        const rad = spawnRadius * Math.sqrt(Math.random());
        // Bias the spawn upwind so the slanted fall carries drops across the view.
        x = cam.x + Math.cos(a) * rad - (windX / Math.max(1, windSpeed)) * 8;
        z = cam.z + Math.sin(a) * rad - (windZ / Math.max(1, windSpeed)) * 8;
        y = cam.y + 12 + Math.random() * 14;
      }
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      pos[o + 3] = x - sx;
      pos[o + 4] = y + sy;
      pos[o + 5] = z - sz;
    }
    rain.geo.setDrawRange(0, active * 2);
    (rain.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    const nightFactor = this.renderer.getAtmosphere().nightFactor ?? 0;
    rain.material.opacity = (0.13 + intensity * 0.2) * (1 - nightFactor * 0.35);
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
        this.lightningFlash.intensity = 0; // pooled light stays in the scene
        this.lightningFlash = null;
      }
    }
    if (this.lightningBolt) {
      const boltMat = this.lightningBolt.material as THREE.LineBasicMaterial;
      if (boltMat.opacity > 0) boltMat.opacity = Math.max(0, boltMat.opacity - dt * 6);
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

      // Pooled flash light (allocating one per strike forced shader churn).
      if (!this.lightningLightPool) {
        this.lightningLightPool = new THREE.PointLight(0x9fc4e6, 0, 300);
        this.renderer.scene.add(this.lightningLightPool);
      }
      const flash = this.lightningLightPool;
      flash.intensity = 60 + phase * 10;
      flash.distance = Math.max(300, stormR * 0.9);
      flash.position.set(lx, 85 + Math.random() * 50, lz);
      this.lightningFlash = flash;

      // Jagged bolt: cloud base to the sea, brief life synced with the flash.
      if (!this.lightningBolt) {
        const boltGeo = new THREE.BufferGeometry();
        boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
        this.lightningBolt = new THREE.Line(
          boltGeo,
          new THREE.LineBasicMaterial({ color: 0xdceeff, transparent: true, opacity: 0, depthWrite: false }),
        );
        this.lightningBolt.frustumCulled = false;
        this.renderer.scene.add(this.lightningBolt);
      }
      {
        const positions = this.lightningBolt.geometry.getAttribute('position') as THREE.BufferAttribute;
        const topY = 150 + Math.random() * 40;
        let bx = lx;
        let bz = lz;
        for (let i = 0; i < 9; i++) {
          const f = i / 8;
          positions.setXYZ(i, bx, topY * (1 - f), bz);
          bx += (Math.random() - 0.5) * 14;
          bz += (Math.random() - 0.5) * 14;
        }
        positions.needsUpdate = true;
        (this.lightningBolt.material as THREE.LineBasicMaterial).opacity = 0.9;
      }

      // Thunder boom matched to the actual strike distance.
      const localPlayerForThunder = this.getLocalPlayer();
      if (localPlayerForThunder) {
        this.audio.playThunder(this.distance2D(localPlayerForThunder.position.x, localPlayerForThunder.position.z, lx, lz));
      }

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
