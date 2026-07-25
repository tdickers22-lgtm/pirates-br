/** Assorted standalone meshes: nameplates, projectiles, upgrade stations, mermaid. */
import * as THREE from 'three';
import type { Projectile, ShipUpgradeType } from '../../../shared/types/index.js';

/** Floating name label (billboard) that hovers over an opponent's head. */
export function makeNameplateSprite(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 34px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = (name || 'Pirate').slice(0, 16);
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(6, 12, 22, 0.94)';
  ctx.strokeText(label, 128, 34);
  ctx.fillStyle = '#f4e8c6';
  ctx.fillText(label, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  // depthTest ON: names must not read through mountains/ships (wallhack feel —
  // caves made it obvious, every plate on the island glowed through the rock).
  // depthWrite stays off so the transparent quad never punches holes in FX.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true }));
  sprite.scale.set(3.4, 0.85, 1);
  sprite.position.y = 2.35;
  sprite.name = 'nameplate';
  sprite.renderOrder = 998;
  return sprite;
}

export function makeProjectileMesh(projectile: Projectile): THREE.Mesh {
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

export function makeUpgradeStationProp(type: ShipUpgradeType, accentHex: number) {
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
export function buildMermaidMesh(): THREE.Group {
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
