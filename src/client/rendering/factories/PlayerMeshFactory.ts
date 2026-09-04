/** Procedural pirate avatar meshes: body build, team tinting, held-item sockets. */
import * as THREE from 'three';
import { PLAYER } from '../../../shared/constants/index.js';

/**
 * THE avatar skeleton, in metres above the standing surface (the group origin
 * is the SOLES — Game puts the group at the server's player.position, which
 * PhysicsSystem sets to the ground/deck contact point).
 *
 * Before AVATAR-01 this figure was 2.15 m tall (2.47 with the hat) on a 1.75 m
 * collider, and its boots hung 19 cm BELOW the origin: every pirate stood
 * ankle-deep in the deck while looming 45 cm over the camera. Everything here
 * derives from PLAYER.HEAD_Y so the drawn head, the server's headshot sphere
 * and the first-person eye cannot drift apart again. PlayerAnimator imports
 * this table for its base pose; scripts/test-avatar-pose-invariants.mjs holds
 * it to the constants.
 */
export const AVATAR_RIG = {
  /** Head sphere centre = the server headshot sphere centre. */
  headY: PLAYER.HEAD_Y,
  headR: 0.14,
  hairY: PLAYER.HEAD_Y + 0.03,
  hairR: 0.148,
  /** The bandana is a band ON the skull, so it shares the hair's centre. */
  bandanaR: 0.158,
  torsoY: 1.2,
  shirtY: 1.17,
  pelvisY: 0.93,
  coatSkirtY: 0.8,
  armPivotY: 1.42,
  armPivotX: 0.34,
  /** Hip joint. The sole sits exactly this far below it, so a leg pivot that
   *  rides at legPivotY puts the boot on the ground. */
  legPivotY: 0.85,
  legPivotX: 0.14,
  /** Boot centre in leg-pivot space, and the toe offset the sole solve needs. */
  bootY: -0.785,
  bootH: 0.13,
  bootZ: 0.06,
  /** Nameplate / health bar sit just clear of the crown (~1.80). */
  overheadY: PLAYER.HEAD_Y + 0.42,
} as const;

/** Face features were authored on a 0.23 m skull; this scales them to headR. */
const FACE = AVATAR_RIG.headR / 0.23;

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

export function applyPlayerTeamColor(mesh: THREE.Group, color: number) {
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

/** Shared first-person palette so hands, sleeves and cuffs match the avatar. */
const VIEW_HAND_PALETTE = {
  skin: 0xd0a074,
  skinShade: 0xb98a5f,
  coat: 0x5e3626,
  cuff: 0xccbfa4,
} as const;

/**
 * A first-person forearm + gripping fist, built to be parented into the
 * viewmodel roots so it inherits every bob / recoil / swing pose for free.
 *
 * Local frame: the grip point is the ORIGIN, the fingers curl under it, and the
 * forearm runs back toward the camera along +Z, leaving frame behind the wrist.
 * Kept deliberately slim — an oversized forearm reads as a red log across the
 * lower third rather than an arm.
 *
 * @param side −1 = left hand, +1 = right hand (mirrors the thumb).
 */
export function makeViewHand(side: 1 | -1): THREE.Group {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshStandardMaterial({ color: VIEW_HAND_PALETTE.skin, roughness: 0.86 });
  // Fingers are a shade darker so the fist doesn't read as one skin-coloured blob.
  const fingerMat = new THREE.MeshStandardMaterial({ color: VIEW_HAND_PALETTE.skinShade, roughness: 0.88 });
  const coatMat = new THREE.MeshStandardMaterial({ color: VIEW_HAND_PALETTE.coat, roughness: 0.94 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: VIEW_HAND_PALETTE.cuff, roughness: 0.9 });

  // Back of the hand, wrapped over whatever sits at the origin.
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.05, 0.092), skinMat);
  palm.position.set(0, 0.036, 0.008);
  group.add(palm);

  // Four curled fingers closing under the grip.
  for (let f = 0; f < 4; f++) {
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.044, 0.019), fingerMat);
    finger.position.set(0.001, -0.004, 0.036 - f * 0.023);
    finger.rotation.x = -0.3 + f * 0.05;
    group.add(finger);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.022, 0.024), fingerMat);
    tip.position.set(0.001, -0.028, 0.028 - f * 0.023);
    group.add(tip);
  }

  // Thumb laid over the fingers on the inboard side.
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.026, 0.06), skinMat);
  thumb.position.set(side * -0.04, 0.016, 0.006);
  thumb.rotation.z = side * 0.5;
  group.add(thumb);

  // Cuff + sleeve running back out of frame behind the wrist.
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.038, 10), cuffMat);
  cuff.rotation.x = Math.PI * 0.5;
  cuff.position.set(0, 0.032, 0.082);
  group.add(cuff);

  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.32, 10), coatMat);
  forearm.rotation.x = Math.PI * 0.5;
  forearm.position.set(0, 0.026, 0.25);
  group.add(forearm);

  group.name = side < 0 ? 'view-hand-left' : 'view-hand-right';
  return group;
}

export function makePlayerMesh(
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
    new THREE.BoxGeometry(isSkeleton ? 0.39 : 0.52, 0.6, isSkeleton ? 0.2 : 0.29),
    coatMat,
  );
  torso.castShadow = true;
  torso.position.set(0, AVATAR_RIG.torsoY, 0);
  torso.name = 'torso';
  torso.visible = !isSkeleton;
  group.add(torso);

  const shirt = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.17 : 0.29, 0.46, isSkeleton ? 0.17 : 0.3),
    clothMat,
  );
  shirt.castShadow = true;
  shirt.position.set(0, AVATAR_RIG.shirtY, 0.02);
  shirt.name = 'shirt';
  shirt.visible = !isSkeleton;
  group.add(shirt);

  const pelvis = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.27 : 0.44, 0.22, isSkeleton ? 0.15 : 0.24),
    beltMat,
  );
  pelvis.castShadow = true;
  pelvis.position.set(0, AVATAR_RIG.pelvisY, 0);
  pelvis.name = 'pelvis';
  pelvis.visible = !isSkeleton;
  group.add(pelvis);

  const coatSkirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.27, 0.34, 0.44, 7, 1, true),
    coatMat,
  );
  coatSkirt.position.set(0, AVATAR_RIG.coatSkirtY, 0);
  coatSkirt.castShadow = true;
  coatSkirt.name = 'coat-skirt';
  coatSkirt.visible = !isSkeleton;
  group.add(coatSkirt);

  const leftArmPivot = new THREE.Group();
  leftArmPivot.position.set(-AVATAR_RIG.armPivotX, AVATAR_RIG.armPivotY, 0);
  leftArmPivot.name = 'left-arm-pivot';
  const leftArm = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.046 : 0.072, isSkeleton ? 0.06 : 0.085, 0.64, 7),
    isSkeleton ? boneDarkMat : coatMat,
  );
  leftArm.castShadow = true;
  leftArm.position.y = -0.26;
  leftArm.name = 'left-arm';
  leftArmPivot.add(leftArm);
  const leftHand = new THREE.Mesh(
    new THREE.SphereGeometry(isSkeleton ? 0.06 : 0.072, 10, 8),
    skinMat,
  );
  leftHand.castShadow = true;
  leftHand.position.y = -0.59;
  leftHand.name = 'left-hand';
  leftArmPivot.add(leftHand);
  group.add(leftArmPivot);

  const rightArmPivot = new THREE.Group();
  rightArmPivot.position.set(AVATAR_RIG.armPivotX, AVATAR_RIG.armPivotY, 0);
  rightArmPivot.name = 'right-arm-pivot';
  const rightArm = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.046 : 0.072, isSkeleton ? 0.06 : 0.085, 0.64, 7),
    isSkeleton ? boneDarkMat : coatMat,
  );
  rightArm.castShadow = true;
  rightArm.position.y = -0.26;
  rightArm.name = 'right-arm';
  rightArmPivot.add(rightArm);
  const rightHand = new THREE.Mesh(
    new THREE.SphereGeometry(isSkeleton ? 0.06 : 0.072, 10, 8),
    skinMat,
  );
  rightHand.castShadow = true;
  rightHand.position.y = -0.59;
  rightHand.name = 'right-hand';
  rightArmPivot.add(rightHand);
  group.add(rightArmPivot);

  const leftLegPivot = new THREE.Group();
  leftLegPivot.position.set(-AVATAR_RIG.legPivotX, AVATAR_RIG.legPivotY, 0);
  leftLegPivot.name = 'left-leg-pivot';
  const leftLeg = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.05 : 0.085, isSkeleton ? 0.063 : 0.093, 0.74, 8),
    isSkeleton ? boneDarkMat : darkMat,
  );
  leftLeg.castShadow = true;
  leftLeg.position.y = -0.37;
  leftLeg.name = 'left-leg';
  leftLegPivot.add(leftLeg);
  const leftBoot = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.1 : 0.135, AVATAR_RIG.bootH, isSkeleton ? 0.19 : 0.28),
    isSkeleton ? boneDarkMat : darkMat,
  );
  leftBoot.castShadow = true;
  leftBoot.position.set(0, AVATAR_RIG.bootY, AVATAR_RIG.bootZ);
  leftBoot.name = 'left-boot';
  leftLegPivot.add(leftBoot);
  group.add(leftLegPivot);

  const rightLegPivot = new THREE.Group();
  rightLegPivot.position.set(AVATAR_RIG.legPivotX, AVATAR_RIG.legPivotY, 0);
  rightLegPivot.name = 'right-leg-pivot';
  const rightLeg = new THREE.Mesh(
    new THREE.CylinderGeometry(isSkeleton ? 0.05 : 0.085, isSkeleton ? 0.063 : 0.093, 0.74, 8),
    isSkeleton ? boneDarkMat : darkMat,
  );
  rightLeg.castShadow = true;
  rightLeg.position.y = -0.37;
  rightLeg.name = 'right-leg';
  rightLegPivot.add(rightLeg);
  const rightBoot = new THREE.Mesh(
    new THREE.BoxGeometry(isSkeleton ? 0.1 : 0.135, AVATAR_RIG.bootH, isSkeleton ? 0.19 : 0.28),
    isSkeleton ? boneDarkMat : darkMat,
  );
  rightBoot.castShadow = true;
  rightBoot.position.set(0, AVATAR_RIG.bootY, AVATAR_RIG.bootZ);
  rightBoot.name = 'right-boot';
  rightLegPivot.add(rightBoot);
  group.add(rightLegPivot);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(AVATAR_RIG.headR, 18, 14),
    skinMat,
  );
  head.castShadow = true;
  head.position.y = AVATAR_RIG.headY;
  head.name = 'head';
  if (isSkeleton) {
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.22 * FACE, 0.08 * FACE, 0.18 * FACE), boneDarkMat);
    jaw.position.set(0, -0.15 * FACE, 0.03 * FACE);
    head.add(jaw);

    const noseCavity = new THREE.Mesh(new THREE.ConeGeometry(0.045 * FACE, 0.12 * FACE, 3), socketMat);
    noseCavity.position.set(0, -0.03 * FACE, 0.2 * FACE);
    noseCavity.rotation.x = Math.PI * 0.52;
    head.add(noseCavity);

    for (const side of [-1, 1] as const) {
      const socket = new THREE.Mesh(new THREE.SphereGeometry(0.055 * FACE, 8, 8), socketMat);
      socket.position.set(side * 0.09 * FACE, 0.03 * FACE, 0.17 * FACE);
      socket.scale.z = 0.8;
      head.add(socket);
    }
  } else {
    // Living pirate face — brow, eyes, nose, a chin beard and a moustache, so
    // crew/NPCs read as weathered pirates, not blank mannequin heads.
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x140f0a, roughness: 0.6 });
    for (const side of [-1, 1] as const) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032 * FACE, 8, 6), eyeMat);
      eye.position.set(side * 0.085 * FACE, 0.035 * FACE, 0.205 * FACE);
      eye.scale.z = 0.65;
      head.add(eye);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.095 * FACE, 0.024 * FACE, 0.03 * FACE), darkMat);
      brow.position.set(side * 0.085 * FACE, 0.095 * FACE, 0.208 * FACE);
      brow.rotation.z = side * -0.14;
      head.add(brow);
    }
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.052 * FACE, 0.08 * FACE, 0.06 * FACE), skinMat);
    nose.position.set(0, -0.01 * FACE, 0.225 * FACE);
    nose.name = 'nose';
    head.add(nose);
    const beard = new THREE.Mesh(new THREE.BoxGeometry(0.19 * FACE, 0.15 * FACE, 0.12 * FACE), darkMat);
    beard.position.set(0, -0.135 * FACE, 0.135 * FACE);
    beard.name = 'beard';
    head.add(beard);
    const moustache = new THREE.Mesh(new THREE.BoxGeometry(0.15 * FACE, 0.035 * FACE, 0.05 * FACE), darkMat);
    moustache.position.set(0, -0.055 * FACE, 0.205 * FACE);
    moustache.name = 'moustache';
    head.add(moustache);
  }
  group.add(head);

  if (isSkeleton) {
    // Cervical stack: without it the skull floated a clear 0.2m above the
    // ribcage and read as decapitated-but-hovering at close range.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.046, 0.2, 6), boneDarkMat);
    neck.position.set(0, 1.47, 0);
    neck.castShadow = true;
    group.add(neck);

    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.038, 0.46, 6), boneDarkMat);
    spine.position.set(0, 1.14, -0.017);
    spine.castShadow = true;
    group.add(spine);

    const sternum = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.32, 0.1), boneMat);
    sternum.position.set(0, AVATAR_RIG.torsoY, 0.034);
    sternum.castShadow = true;
    group.add(sternum);

    for (const side of [-1, 1] as const) {
      for (let rib = 0; rib < 3; rib++) {
        const ribMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.014, 0.017, 0.25 + rib * 0.025, 5),
          boneDarkMat,
        );
        ribMesh.position.set(side * (0.093 + rib * 0.025), 1.3 - rib * 0.12, 0.042 + rib * 0.008);
        ribMesh.rotation.z = side * (Math.PI * 0.34 + rib * 0.05);
        ribMesh.rotation.x = Math.PI * 0.28;
        ribMesh.castShadow = true;
        group.add(ribMesh);
      }
    }
    const hipBone = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.068, 0.1), boneDarkMat);
    hipBone.position.set(0, AVATAR_RIG.pelvisY, 0.017);
    hipBone.castShadow = true;
    group.add(hipBone);
  }

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(AVATAR_RIG.hairR, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
    darkMat,
  );
  hair.castShadow = true;
  hair.position.y = AVATAR_RIG.hairY;
  hair.name = 'hair';
  hair.visible = !isSkeleton;
  group.add(hair);

  if (!isSkeleton && isCaptain) {
    const hat = new THREE.Group();
    hat.name = 'hat';
    hat.position.set(0, 0.08 * FACE, 0);

    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34 * FACE, 0.42 * FACE, 0.05 * FACE, 18),
      new THREE.MeshStandardMaterial({ color: 0x1d1410, roughness: 0.95 }),
    );
    brim.castShadow = true;
    hat.add(brim);

    const crown = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17 * FACE, 0.2 * FACE, 0.22 * FACE, 14),
      new THREE.MeshStandardMaterial({ color: 0x2b1b15, roughness: 0.92 }),
    );
    crown.position.y = 0.12 * FACE;
    crown.castShadow = true;
    hat.add(crown);

    const feather = new THREE.Mesh(
      new THREE.PlaneGeometry(0.1 * FACE, 0.34 * FACE),
      new THREE.MeshStandardMaterial({ color: 0xc7e0f0, roughness: 0.8, side: THREE.DoubleSide }),
    );
    feather.position.set(-0.13 * FACE, 0.24 * FACE, 0.04 * FACE);
    feather.rotation.set(0.28, 0.32, 0.42);
    feather.castShadow = true;
    hat.add(feather);
    head.add(hat);

    const beard = new THREE.Mesh(
      new THREE.ConeGeometry(0.09 * FACE, 0.22 * FACE, 8),
      new THREE.MeshStandardMaterial({ color: 0x33231c, roughness: 0.96 }),
    );
    beard.position.set(0, -0.2 * FACE, 0.04 * FACE);
    beard.name = 'beard';
    beard.rotation.x = Math.PI;
    beard.castShadow = true;
    head.add(beard);

    const moustache = new THREE.Mesh(
      new THREE.BoxGeometry(0.16 * FACE, 0.03 * FACE, 0.03 * FACE),
      new THREE.MeshStandardMaterial({ color: 0x2b1d18, roughness: 0.96 }),
    );
    moustache.position.set(0, -0.04 * FACE, 0.2 * FACE);
    moustache.name = 'moustache';
    moustache.castShadow = true;
    head.add(moustache);
  }

  const bandanaMat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  const bandana = new THREE.Mesh(
    new THREE.TorusGeometry(0.2, 0.04, 6, 18),
    bandanaMat,
  );
  bandana.rotation.x = Math.PI * 0.5;
  bandana.position.y = AVATAR_RIG.hairY;
  bandana.name = 'bandana';
  bandana.visible = !isSkeleton && !isCaptain;
  group.add(bandana);

  const healthBarRoot = new THREE.Group();
  healthBarRoot.position.set(0, AVATAR_RIG.overheadY, 0);
  healthBarRoot.visible = false;
  const healthBarBack = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.14),
    new THREE.MeshBasicMaterial({ color: 0x081015, transparent: true, opacity: 0.82, depthWrite: false }),
  );
  healthBarBack.position.z = -0.003;
  healthBarBack.renderOrder = 10;
  healthBarRoot.add(healthBarBack);
  const healthBarFill = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.07),
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
      rightHand,
    },
  };
  group.userData.healthBar = {
    root: healthBarRoot,
    fill: healthBarFill,
    fullWidth: 0.7,
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
