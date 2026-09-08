import * as THREE from 'three';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { WildlifeAnimal } from '../../../shared/types/index.js';
import { assets, type AssetName } from '../../assets/AssetLibrary.js';
import type { RenderQuality } from '../QualityPreference.js';

/**
 * EVERY CREATURE MESH THE GAME BUILDS, in one place (FAUNAGLB-01, assets-12).
 *
 * These two builders were 286 lines in the middle of Game.ts, between the
 * wildlife sync and the upgrade stations, and they are the only code that knows
 * what a shark or a pig is MADE of. Game.ts now asks for one and animates it.
 *
 * The shark is the interesting one. Three bodies can come back:
 *
 *   SKINNED HERO (balanced/high) — shark.glb is an 8.3k-tri lofted fusiform on
 *     a 9-bone armature with `swim` and `bite` clips. Cloned with SkeletonUtils,
 *     NOT Object3D.clone(): three copies a SkinnedMesh's skeleton by reference,
 *     so four sharks cloned the plain way all pose off one set of bones that
 *     live in no scene and never update — they would freeze in bind pose
 *     together. `userData.fauna.mixer` is set and SharkRenderer drives clips.
 *
 *   RIGID PUPPET (low tier, or a hero that failed to load) — shark_far.glb,
 *     1,058 tris, no skin, carrying the four pivot nodes shark_tail /
 *     shark_jaw / shark_pec_l / shark_pec_r. SHARK.MAX_WORLD is 4, so taking
 *     the hero on `low` would put ~+25k triangles and a skinning shader variant
 *     into the frame of the machine least able to pay for either. Same pivot
 *     animator as before this lane, unchanged.
 *
 *   PROCEDURAL — the primitive shark, for the window before the GLBs are in.
 *     It carries the same four pivot names, so nothing downstream branches.
 *
 * `userData.parts` (pivot nodes) and `userData.fauna` (mixer + actions) are the
 * whole contract with SharkRenderer; exactly one of them is populated.
 */

/** What a shark mesh carries for its animator. `mixer` null = pivot path. */
export interface SharkAnimData {
  mixer: THREE.AnimationMixer | null;
  swim: THREE.AnimationAction | null;
  bite: THREE.AnimationAction | null;
  /** True for the skinned hero — SharkRenderer keeps the pivot maths off it. */
  skinned: boolean;
}

/** The skinned hero, cloned so its skeleton is its own. Null on the low tier,
 *  before the world assets are in, or if shark.glb ever ships without clips. */
function buildSkinnedShark(): THREE.Group | null {
  const src = assets.source('shark' as string as AssetName);
  if (!src) return null;
  let skinnedMeshes = 0;
  src.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes += 1; });
  if (!skinnedMeshes || src.animations.length === 0) return null;

  const root = cloneSkinnedScene(src.scene) as THREE.Group;
  const group = new THREE.Group();
  group.add(root);
  const mixer = new THREE.AnimationMixer(root);
  const clip = (name: string) => {
    const found = THREE.AnimationClip.findByName(src.animations, name);
    return found ? mixer.clipAction(found) : null;
  };
  const swim = clip('swim');
  const bite = clip('bite');
  if (swim) { swim.setLoop(THREE.LoopRepeat, Infinity); swim.play(); }
  if (bite) { bite.setLoop(THREE.LoopOnce, 1); bite.clampWhenFinished = true; }
  const fauna: SharkAnimData = { mixer, swim, bite, skinned: true };
  group.userData.fauna = fauna;
  group.userData.parts = {};
  return group;
}

export function buildWildlifeMesh(animal: WildlifeAnimal, quality: RenderQuality): THREE.Group {
    // Blender GLB first (authored in parallel — standard part names drive the
    // same sync animation); missing asset keeps the procedural fallback.
    const glb = assets.clone(animal.type as string as AssetName);
    if (glb) {
      const glbGroup = new THREE.Group();
      glbGroup.name = `wildlife-${animal.id}`;
      glbGroup.add(glb);
      const glbParts: Record<string, THREE.Object3D> = {};
      for (const partName of ['body', 'head', 'leftWing', 'rightWing', 'leg0', 'leg1', 'leg2', 'leg3', 'leg4', 'leg5']) {
        const node = glb.getObjectByName(partName);
        if (node) glbParts[partName] = node;
      }
      glbGroup.userData.parts = glbParts;
      return glbGroup;
    }

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

    if (quality === 'low') {
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

export function buildSharkMesh(quality: RenderQuality): THREE.Group {
    // THE TIER GATE. `low` never sees the skinned hero: SHARK.MAX_WORLD is 4,
    // so 8.3k tris and a skinning shader variant each is ~+25k triangles and a
    // second program in the frame of the machine least able to pay for either.
    // It gets shark_far.glb — the 1,058-tri rigid puppet, the same silhouette,
    // driven by the same pivot animator that drove every shark before this lane.
    if (quality !== 'low') {
      const hero = buildSkinnedShark();
      if (hero) return hero;
    }
    // Pivot path: the far puppet by preference, then the near GLB (which on the
    // low tier means the hero standing in bind pose rather than nothing), then
    // the primitives below. All three carry the same four pivot node names, so
    // syncSharks drives every one of them with the same code.
    const glb = assets.cloneFar('shark' as string as AssetName)
      ?? assets.clone('shark' as string as AssetName);
    if (glb) {
      const glbGroup = new THREE.Group();
      glbGroup.add(glb);
      const glbParts: Record<string, THREE.Object3D> = {};
      for (const partName of ['shark_tail', 'shark_jaw', 'shark_pec_l', 'shark_pec_r']) {
        const node = glb.getObjectByName(partName);
        if (node) glbParts[partName] = node;
      }
      glbGroup.userData.parts = glbParts;
      glbGroup.userData.fauna = { mixer: null, swim: null, bite: null, skinned: false };
      return glbGroup;
    }

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

    // Tail pivot — syncSharks swings rotation.y for the swim/thrash cycle.
    const parts: Record<string, THREE.Object3D> = {};
    g.userData.parts = parts;
    g.userData.fauna = { mixer: null, swim: null, bite: null, skinned: false };
    const tailPivot = new THREE.Group();
    tailPivot.name = 'shark_tail';
    tailPivot.position.set(-0.9, 0.1, 0);
    g.add(tailPivot);
    parts.shark_tail = tailPivot;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.62, 8), finMat);
    tail.rotation.z = Math.PI * 0.5;
    tail.position.set(-0.15, 0.02, 0);
    tail.castShadow = true;
    tailPivot.add(tail);

    const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.62, 6), finMat);
    dorsal.position.set(0.05, 0.52, 0);
    dorsal.rotation.z = Math.PI * 0.5;
    g.add(dorsal);

    // Pec pivots carry a zero neutral so syncSharks can flare rotation.z
    // directly; the base fin angle is baked into the mesh inside.
    for (const side of [1, -1] as const) {
      const pecPivot = new THREE.Group();
      pecPivot.name = side > 0 ? 'shark_pec_l' : 'shark_pec_r';
      pecPivot.position.set(0.35, -0.18, side * 0.42);
      const pec = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.38), finMat);
      pec.rotation.set(0.2, 0, side * 0.35);
      pecPivot.add(pec);
      g.add(pecPivot);
      parts[pecPivot.name] = pecPivot;
    }

    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.3 }));
    eyeL.position.set(0.82, 0.18, 0.16);
    g.add(eyeL);
    const eyeR = eyeL.clone();
    eyeR.position.z = -0.16;
    g.add(eyeR);

    // Jaw pivot: yawed π/2 so the child's local +Z runs down the snout —
    // syncSharks opens the bite with plain rotation.x, matching GLB jaws.
    const jawPivot = new THREE.Group();
    jawPivot.position.set(1.05, -0.08, 0);
    jawPivot.rotation.y = Math.PI * 0.5;
    g.add(jawPivot);
    const jaw = new THREE.Group();
    jaw.name = 'shark_jaw';
    jawPivot.add(jaw);
    parts.shark_jaw = jaw;
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.3), darkMat);
    mouth.position.set(0, -0.04, 0.21);
    mouth.rotation.x = 0.12;
    jaw.add(mouth);

    for (let i = 0; i < 7; i++) {
      const lx = -(-0.18 + i * 0.06);
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.07, 4), toothMat);
      tooth.position.set(lx, -0.08, 0.23);
      tooth.rotation.x = Math.PI;
      tooth.rotation.z = i % 2 === 0 ? 0.12 : -0.12;
      jaw.add(tooth);
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
    tailTop.position.set(-0.55, 0.24, 0);
    tailTop.rotation.z = -0.42;
    tailPivot.add(tailTop);
    const tailBottom = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.08), finMat);
    tailBottom.position.set(-0.53, -0.28, 0);
    tailBottom.rotation.z = 0.52;
    tailPivot.add(tailBottom);

    const rearDorsal = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 5), finMat);
    rearDorsal.position.set(-0.62, 0.38, 0);
    rearDorsal.rotation.z = Math.PI * 0.5;
    g.add(rearDorsal);

    return g;
  }
