/** Assorted standalone meshes: nameplates, projectiles, upgrade stations, mermaid. */
import * as THREE from 'three';
import type { Projectile, ShipUpgradeType } from '../../../shared/types/index.js';
import { AVATAR_RIG } from './PlayerMeshFactory.js';

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
  sprite.scale.set(2.8, 0.7, 1);
  sprite.position.y = AVATAR_RIG.overheadY + 0.22;
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
 * THE MERMAID — the one friendly figure in the Reach, and the only thing in the
 * water that means "you are not finished".
 *
 * She marks a drowning pirate's [X] back to his ship, so she has to read as
 * ALIVE from thirty metres of open water, at night, over swell. The first build
 * was a primitive assembly: a capsule, a sphere, two cones and two arm blobs
 * pinned at a fixed angle, welded into one frozen pose. Held against the swell
 * she looked like a buoy with a face — nothing about her moved, which is the
 * one cue that separates "somebody is out here" from "a bit of wreckage".
 *
 * So she is now RIGGED, cheaply and procedurally (the viewmodel-arm pattern —
 * nested groups and a sine clock, no GLB, no skinning, no per-frame allocation):
 *
 *  · ARMS — shoulder → elbow → hand, sculling slowly to hold station, the way
 *    anyone treading water actually keeps their head up;
 *  · TAIL — three nested segments plus the fin, driven by a TRAVELLING wave
 *    (each segment lags the one above it), which is what makes a tail look like
 *    it is pushing water rather than wagging;
 *  · a counter-roll through the torso and a slow turn of the head, because a
 *    body that sways below and stays rigid above reads as a puppet.
 *
 * The sway is dominant about Z (side to side across the view) because she is
 * always yawed to FACE the player — an undulation in the fore-aft plane would
 * be almost entirely foreshortened away at the only angle she is ever seen from.
 *
 * DRIVING IT: the clock is her own. The animation is a pure function of time
 * hung on `userData.animate`, and the halo mesh's `onBeforeRender` calls it, so
 * she animates wherever she is added to a scene without a frame-loop owner
 * having to know she exists. Calling `animate(t)` yourself is safe and
 * idempotent — it only ever ASSIGNS rotations from t.
 */
export function buildMermaidMesh(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'mermaid';

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xfdd9b8,
    emissive: 0x86e8ff,
    emissiveIntensity: 0.45,
    roughness: 0.55,
    metalness: 0.05,
  });
  // Limbs carry LESS of the aqua glow than the torso on purpose. At full
  // emissive everything skin-coloured blooms to the same flat white and the arms
  // vanish into the chest — the shading gradient is the only thing that says
  // "there is an arm there" at the range she is actually read from.
  const limbMat = new THREE.MeshStandardMaterial({
    color: 0xf3c8a4,
    emissive: 0x86e8ff,
    emissiveIntensity: 0.2,
    roughness: 0.6,
    metalness: 0.05,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x2cd0bf,
    emissive: 0x47e8d6,
    emissiveIntensity: 0.55,
    roughness: 0.35,
    metalness: 0.4,
  });

  // Soft glow halo so she's visible at distance. It is also the animation's
  // heartbeat (see onBeforeRender at the bottom): a Group gets no render hook,
  // and this is the one mesh that is always drawn when she is on screen.
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

  // ── Upper body ────────────────────────────────────────────────────────────
  // Everything above the hips hangs off one pivot so the counter-roll carries
  // the head and both arms with it instead of shearing her at the neck.
  const bust = new THREE.Group();
  bust.position.y = 0.7;
  group.add(bust);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 6, 12), skinMat);
  torso.position.y = 0.35;
  bust.add(torso);

  const head = new THREE.Group();
  head.position.y = 0.85;
  bust.add(head);
  head.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe6cc, roughness: 0.5, metalness: 0.05 }),
  ));
  // Hair (dark teal flowing back) — parented to the head so a glance carries it.
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6),
    new THREE.MeshStandardMaterial({ color: 0x153a4a, roughness: 0.7 }),
  );
  hair.position.set(0, 0.05, -0.05);
  head.add(hair);

  // ── Arms: shoulder → elbow → hand ─────────────────────────────────────────
  // Each limb hangs down its parent's −Y, so a roll about Z sweeps it out to the
  // side (the scull) and a pitch about X pulls it fore-and-aft.
  const shoulders: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Group();
    // Clear of the torso capsule (r 0.32) — parked inside it, the first build's
    // arms were invisible against her own chest at every angle she is seen from.
    shoulder.position.set(0.33 * sx, 0.7, 0.05);
    bust.add(shoulder);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.3, 4, 8), limbMat);
    upper.position.y = -0.15;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.32;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.066, 0.28, 4, 8), limbMat);
    fore.position.y = -0.14;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), limbMat);
    hand.position.y = -0.3;
    hand.scale.set(1, 0.72, 0.6);
    elbow.add(hand);

    shoulders.push(shoulder);
    elbows.push(elbow);
  }

  // ── Tail: three nested segments and a fin ─────────────────────────────────
  const tailRoot = new THREE.Group();
  tailRoot.position.y = 0.68;
  group.add(tailRoot);
  const SEGMENTS: Array<[number, number, number]> = [
    // [top radius, bottom radius, length]
    [0.3, 0.21, 0.46],
    [0.21, 0.13, 0.42],
    [0.13, 0.06, 0.34],
  ];
  const tailJoints: THREE.Group[] = [];
  let joint: THREE.Group = tailRoot;
  for (const [top, bottom, length] of SEGMENTS) {
    const seg = new THREE.Group();
    joint.add(seg);
    tailJoints.push(seg);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, length, 12), tailMat);
    mesh.position.y = -length / 2;
    seg.add(mesh);
    const next = new THREE.Group();
    next.position.y = -length;
    seg.add(next);
    joint = next;
  }

  // Tail fin (a flat fan) — on the last joint, so it whips a beat behind the
  // segment that drives it.
  const finPivot = new THREE.Group();
  joint.add(finPivot);
  tailJoints.push(finPivot);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.55, 8, 1, true), tailMat);
  fin.rotation.x = Math.PI;
  fin.scale.set(1.0, 0.18, 1.0);
  fin.position.y = -0.05;
  finPivot.add(fin);

  // ── The clock ─────────────────────────────────────────────────────────────
  const phase = Math.random() * Math.PI * 2;
  group.userData.bobPhase = phase;

  /** Pure function of seconds: assign-only, so double-driving is harmless. */
  const animate = (t: number): void => {
    const swim = t * 1.55 + phase;
    // A TRAVELLING wave: every joint lags the one above it by ~0.85 rad, and the
    // amplitude grows toward the tip. Equal-phase segments read as one stiff
    // plank hinged at the hips, which is exactly how the old cones read.
    for (let i = 0; i < tailJoints.length; i++) {
      const lag = swim - i * 0.85;
      const amp = 0.13 + i * 0.075;
      tailJoints[i].rotation.z = Math.sin(lag) * amp;
      // A little fore-aft on top of it so the tail is not a flat 2D wag.
      tailJoints[i].rotation.x = Math.sin(lag * 0.62 + 1.1) * amp * 0.42;
    }
    // Hips lead, shoulders answer: the counter-roll is what stops a swaying
    // tail from looking bolted to a mannequin.
    bust.rotation.z = Math.sin(swim + 0.6) * -0.07;
    bust.rotation.y = Math.sin(t * 0.42 + phase) * 0.1;
    head.rotation.y = Math.sin(t * 0.31 + phase * 0.5) * 0.26;
    head.rotation.x = Math.sin(t * 0.5 + phase) * 0.07;
    // Sculling: the arms sweep out and in a beat apart, elbows trailing. The
    // upper arms stay well inside a T — held out at ~25° they read as a person
    // holding station, held out at 60° they read as a scarecrow.
    for (let i = 0; i < shoulders.length; i++) {
      const sx = i === 0 ? -1 : 1;
      const arm = t * 1.1 + phase + i * 0.7;
      shoulders[i].rotation.z = sx * (0.52 + Math.sin(arm) * 0.18);
      // Deliberately SHALLOW fore-and-aft. She is always yawed at the player, so
      // an elbow folded hard toward the camera foreshortens the forearm into a
      // knuckle — the same sliver the cutlass thrust and the axe apex had to fix.
      shoulders[i].rotation.x = 0.08 + Math.sin(arm * 0.8 + 0.4) * 0.18;
      elbows[i].rotation.x = -0.4 - Math.sin(arm - 0.7) * 0.22;
      // The bend that reads: upper arm out, forearm back in across the body.
      elbows[i].rotation.z = -sx * (0.6 + Math.sin(arm + 0.5) * 0.2);
    }
  };
  group.userData.animate = animate;

  // Her own heartbeat. A Group is never "rendered", so the hook lives on the
  // halo — the one mesh guaranteed to be drawn whenever she is visible. This is
  // what lets her be alive without a frame-loop owner knowing she exists.
  halo.onBeforeRender = () => animate(performance.now() / 1000);

  animate(0);
  return group;
}
