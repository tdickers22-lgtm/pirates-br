/** Held-weapon and pocket-item meshes plus the shared viewmodel material tweak. */
import * as THREE from 'three';
import type { WeaponInstance } from '../../../shared/types/index.js';
import { registerBudgetLight } from '../LightBudget.js';

export function makeHeldWeaponMesh(weaponId: WeaponInstance['weaponId']): THREE.Group {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6a4322, roughness: 0.95 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xb9c2c9, roughness: 0.45, metalness: 0.75 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xb88a34, roughness: 0.5, metalness: 0.85 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x26201a, roughness: 0.95 });

  if (weaponId === 'cutlass') {
    // Real steel, not a white slab: darker base metal with a bright ground
    // edge and a dark fuller down the flat, built as three slightly swept
    // segments so the blade curves like a cutlass instead of reading as a
    // featureless plank.
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x8e9aa6, roughness: 0.34, metalness: 0.88 });
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0xe4ecf2, roughness: 0.16, metalness: 0.95, emissive: 0x22303a, emissiveIntensity: 0.35,
    });
    const fullerMat = new THREE.MeshStandardMaterial({ color: 0x59636d, roughness: 0.55, metalness: 0.7 });

    const bladeRoot = new THREE.Group();
    bladeRoot.position.y = 0.08;
    group.add(bladeRoot);
    const segments = [
      { y: 0.15, len: 0.32, w: 0.058, tilt: 0.0, x: 0 },
      { y: 0.46, len: 0.32, w: 0.052, tilt: 0.05, x: 0.012 },
      { y: 0.76, len: 0.3, w: 0.044, tilt: 0.11, x: 0.038 },
    ];
    for (const seg of segments) {
      const part = new THREE.Mesh(new THREE.BoxGeometry(seg.w, seg.len, 0.022), bladeMat);
      part.position.set(seg.x, seg.y, 0);
      part.rotation.z = -seg.tilt;
      part.castShadow = true;
      bladeRoot.add(part);
      // Ground edge strip along the cutting side.
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.012, seg.len, 0.026), edgeMat);
      edge.position.set(seg.x + seg.w * 0.46, seg.y, 0);
      edge.rotation.z = -seg.tilt;
      bladeRoot.add(edge);
      // Fuller groove down the flat.
      const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.016, seg.len * 0.92, 0.03), fullerMat);
      fuller.position.set(seg.x - seg.w * 0.1, seg.y, 0);
      fuller.rotation.z = -seg.tilt;
      bladeRoot.add(fuller);
    }

    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.16, 5), edgeMat);
    tip.position.set(0.062, 0.98, 0);
    tip.rotation.z = -0.14;
    tip.castShadow = true;
    bladeRoot.add(tip);

    // Knuckle bow, not a giant gold donut: a half torus sweeping from the
    // guard down to the pommel on the knuckle side.
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.028, 0.05), brassMat);
    guard.position.y = 0.055;
    guard.castShadow = true;
    group.add(guard);

    const knuckleBow = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 6, 14, Math.PI * 1.05), brassMat);
    knuckleBow.rotation.y = Math.PI * 0.5;
    knuckleBow.rotation.z = -Math.PI * 0.5;
    knuckleBow.position.set(-0.06, -0.09, 0);
    knuckleBow.castShadow = true;
    group.add(knuckleBow);

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.038, 0.26, 8), darkMat);
    grip.position.y = -0.11;
    grip.castShadow = true;
    group.add(grip);

    for (const y of [-0.04, -0.11, -0.18]) {
      const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.033, 0.006, 5, 10), brassMat);
      wrap.rotation.x = Math.PI * 0.5;
      wrap.position.y = y;
      group.add(wrap);
    }

    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), brassMat);
    pommel.position.y = -0.26;
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

export type PocketPreviewKind = 'banana' | 'wood' | 'coconut' | 'mango' | 'meat' | 'powder_keg' | 'shovel' | 'chest' | 'bucket' | 'compass' | 'spyglass' | 'lantern' | 'axe';

export function makePocketPreviewMesh(kind: PocketPreviewKind): THREE.Group {
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
    registerBudgetLight(sparkLight);
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
  } else if (kind === 'axe') {
    // Hatchet: wooden haft + wedge steel head (shovel-style forward axis).
    const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.023, 0.5, 8), woodMat);
    haft.rotation.x = Math.PI * 0.5;
    haft.position.z = -0.04;
    group.add(haft);
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.034, 0.05, 8), iron);
    eye.rotation.x = Math.PI * 0.5;
    eye.position.z = 0.19;
    group.add(eye);
    // Wedge head: a box tapered toward the cutting edge.
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.1), iron);
    head.position.set(0, -0.075, 0.19);
    head.scale.set(1, 1, 1.15);
    group.add(head);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.17, 0.11), iron);
    edge.position.set(0, -0.15, 0.19);
    group.add(edge);
    const buttCap = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 8), husk);
    buttCap.rotation.x = Math.PI * 0.5;
    buttCap.position.z = -0.3;
    group.add(buttCap);
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
    registerBudgetLight(glow);
    group.add(glow);

    // Forearms gripping the chest from below — sells the carry pose in first-person.
    for (const side of [-1, 1]) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), skinMat);
      hand.position.set(side * 0.22, -0.18, 0.18);
      hand.scale.set(1.1, 0.85, 1.0);
      group.add(hand);
    }
  } else if (kind === 'bucket') {
    const staveMat = new THREE.MeshStandardMaterial({ color: 0x7a5024, roughness: 0.9 });
    const innerMat = new THREE.MeshStandardMaterial({ color: 0x4a3218, roughness: 0.96, side: THREE.BackSide });
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x2f7fb0, roughness: 0.22, metalness: 0.1 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.084, 0.2, 18, 1, true), staveMat);
    group.add(body);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.104, 0.08, 0.19, 18, 1, true), innerMat);
    group.add(inner);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.02, 18), staveMat);
    base.position.y = -0.1;
    group.add(base);
    const surface = new THREE.Mesh(new THREE.CylinderGeometry(0.099, 0.099, 0.008, 18), waterMat);
    surface.position.y = 0.045;
    surface.name = 'bucket-water'; // toggled by bucketFilled in syncLocalViewPocket
    group.add(surface);
    for (const [y, r] of [[-0.075, 0.092], [0.086, 0.112]] as const) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(r, 0.008, 6, 20), iron);
      hoop.rotation.x = Math.PI * 0.5;
      hoop.position.y = y;
      group.add(hoop);
    }
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.007, 6, 18, Math.PI), iron);
    handle.position.y = 0.1;
    handle.rotation.y = Math.PI * 0.5;
    group.add(handle);
  } else if (kind === 'compass') {
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.32, metalness: 0.85, emissive: 0x140d02, emissiveIntensity: 0.12 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0xe9dcbb, roughness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfe0ff, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.3 });
    const caseMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.034, 22), brass);
    caseMesh.rotation.x = Math.PI * 0.5;
    group.add(caseMesh);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.064, 0.006, 22), faceMat);
    face.rotation.x = Math.PI * 0.5;
    face.position.z = -0.014;
    group.add(face);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.066, 0.004, 22), glassMat);
    glass.rotation.x = Math.PI * 0.5;
    glass.position.z = -0.02;
    group.add(glass);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.03, 8), brass);
    pin.rotation.x = Math.PI * 0.5;
    pin.position.z = -0.02;
    group.add(pin);
    const needleN = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.05, 4), new THREE.MeshStandardMaterial({ color: 0xd2382a }));
    needleN.position.set(0, 0.025, -0.02);
    group.add(needleN);
    const needleS = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.05, 4), new THREE.MeshStandardMaterial({ color: 0xdedbd0 }));
    needleS.position.set(0, -0.025, -0.02);
    needleS.rotation.z = Math.PI;
    group.add(needleS);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.014, 22, 1, false, 0, Math.PI), brass);
    lid.rotation.x = Math.PI * 0.5;
    lid.position.set(0, 0.086, -0.02);
    lid.rotation.z = -0.5;
    group.add(lid);
  } else if (kind === 'lantern') {
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.5, metalness: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xffd27a, roughness: 0.15, transparent: true, opacity: 0.5, emissive: 0xff9a2e, emissiveIntensity: 1.8 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.05, 12), metal);
    base.position.y = -0.13;
    group.add(base);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.1, 0.18, 12), glassMat);
    group.add(glass);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffcf6a }));
    flame.scale.y = 1.5;
    group.add(flame);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 4), metal);
      bar.position.set(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1);
      group.add(bar);
    }
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.12, 0.07, 12), metal);
    cap.position.y = 0.12;
    group.add(cap);
    const vent = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.06, 8), metal);
    vent.position.y = 0.185;
    group.add(vent);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 6, 14, Math.PI), metal);
    handle.position.y = 0.22;
    handle.rotation.z = Math.PI;
    group.add(handle);
  } else if (kind === 'spyglass') {
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.32, metalness: 0.85 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.88 });
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x1a2a33, roughness: 0.15, metalness: 0.3 });
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.1, 16), brass);
    eye.rotation.x = Math.PI * 0.5;
    eye.position.z = -0.12;
    group.add(eye);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.11, 16), leather);
    grip.rotation.x = Math.PI * 0.5;
    grip.position.z = -0.02;
    group.add(grip);
    const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 16), brass);
    mid.rotation.x = Math.PI * 0.5;
    mid.position.z = 0.08;
    group.add(mid);
    const obj = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.12, 16), brass);
    obj.rotation.x = Math.PI * 0.5;
    obj.position.z = 0.2;
    group.add(obj);
    const objLens = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.006, 16), lensMat);
    objLens.rotation.x = Math.PI * 0.5;
    objLens.position.z = 0.26;
    group.add(objLens);
    for (const z of [-0.07, 0.03, 0.14] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 6, 16), brass);
      ring.position.z = z;
      group.add(ring);
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

export function applyViewmodelMaterialSettings(root: THREE.Object3D) {
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
