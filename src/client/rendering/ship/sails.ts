import * as THREE from 'three';
import { IK_GRIPS_KEY } from '../character/ikSolvers.js';
import type { SHIP_STATS } from '../../../shared/constants/index.js';
import type { Ship, ShipUpgradeType } from '../../../shared/types/index.js';
import { getMastHeight, getShipRigPlan, hullSurfacePointAt } from '../../../shared/hull.js';
import type { HullProfile } from '../../../shared/hull.js';
import { getBraceStationLocals, getCrowNestStandingY, getMainMastLocalZ, getSailRopeStationLocals } from '../../../shared/utils/index.js';
import type { RenderQuality } from '../Renderer.js';
import { attachSailCloth, makeSailClothGeometry, sailClothGrid } from './sailCloth.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeCylinderBetween, makeRopeCoil } from './dressing.js';
import { buildRigging, buildRigFarCards, planRopes, SLACK_SEGMENTS, SLACK_SEGMENTS_PHONE, type RigPlanMast, type RopeRun, type Rigging, type RiggingSet } from './rigging.js';

// Square-sail cloth is GPU cloth (ship/sailCloth.ts, b4.2g): a flat grid
// whose belly, flutter, hoist folds and tear holes are computed in the vertex
// and fragment shaders from per-sail uniforms. No CPU cloth step remains.

export interface RigContext {
  group: THREE.Group;
  ship: Ship;
  stats: (typeof SHIP_STATS)[Ship['type']];
  profile: HullProfile;
  H: number;
  L: number;
  W: number;
  darkMat: THREE.MeshStandardMaterial;
  deckMat: THREE.MeshStandardMaterial;
  sailMat: THREE.MeshStandardMaterial;
  upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]>;
  quality: RenderQuality;
  /** b4.2h: phone build (ShipRenderer.setLodPhone): the lite rope plan. */
  phone?: boolean;
  darkWoodTex: THREE.Texture;
  teamSailTexture: (teamColor: number) => THREE.Texture;
  addSwiftSailTrim: (sail: THREE.Mesh, width: number, height: number, targets: THREE.Object3D[], staySail?: boolean) => void;
}

export interface RigBuild {
  sails: THREE.Mesh[];
  furledSails: THREE.Mesh[];
  pennants: THREE.Mesh[];
  trimPivots: THREE.Group[];
  nestFloorMesh: THREE.Mesh | undefined;
  mastCount: number;
  mastStartZ: number;
  ropeRig: Rigging | null;
  ratlineRig: Rigging | null;
  /** b4.2h: rope + ratline + far cards; NOT added to the group (ShipRenderer
   *  parents it to ship-rig-root, drawn LOD0-LOD2, cards at LOD3). */
  rigSet: RiggingSet | null;
}

/** The whole rig of one hull, moved out of ShipRenderer.buildShip (b4.2a):
 *  masts + caps + pennants, the crow's nest, yards in trim pivots with their
 *  square sails and furled bundles, the nest ladder (its own ladderTop /
 *  ladderBottom live inside, nothing outside reads them), the rail rope and
 *  brace stations, the jib + furled jib, the stays, and the two instanced
 *  rigging draws. Adds to `group` in exactly the order the inline block did,
 *  so test-ship-geometry-hash is unchanged. */
export function buildRig(ctx: RigContext): RigBuild {
  const { group, ship, stats, profile, H, L, darkMat, deckMat, sailMat, upgradeVisuals, quality, darkWoodTex, teamSailTexture, addSwiftSailTrim } = ctx;
  const sails: THREE.Mesh[] = [];
  const furledSails: THREE.Mesh[] = [];
  const pennants: THREE.Mesh[] = [];
  const trimPivots: THREE.Group[] = [];
  let nestFloorMesh: THREE.Mesh | undefined;
  const mastCount = stats.mastCount;
  // Keep the aftmost mast forward of the stern helm so its sail never drapes
  // over the wheel (aftmost lands ~-L*0.14, wheel sits at -L*0.315).
  const mastStartZ = L * 0.28;
  // b4.2f: every rig number (mast heights, yards, course + topsail, spanker)
  // comes from the shared plan the server's chainshot band also reads.
  const rigPlan = getShipRigPlan(stats);

  // All rigging collapses into two INSTANCED draw calls (rope + ratline): one
  // draw each, exactly as the old LineSegments, but lit, shadowed and thick
  // enough to survive a resolve — and the runs that end ON a yard carry their
  // seat in pivot-local space so they follow the spar when she is braced
  // (ships-16). See src/client/rendering/ship/rigging.ts.
  const ropeRuns: RopeRun[] = [];
  const ratlineRuns: RopeRun[] = [];
  const yardHalfSpanForMast: number[] = [];
  // b4.2h: the per-class rope plan (ship/rigging.ts planRopes) reads these.
  const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);
  const planMasts: RigPlanMast[] = [];
  let mainTrimPivotForPlan: THREE.Group | null = null;

  for (let m = 0; m < mastCount; m++) {
    const mastPlan = rigPlan[m];
    const mastZ = mastPlan.z;
    const mastH = mastPlan.height;
    const planMast: RigPlanMast = { z: mastZ, height: mastH, mastR, nestY: null, yards: [] };
    planMasts.push(planMast);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(mastR * 0.8, mastR * 1.4, mastH, 16),
      darkMat,
    );
    mast.name = `mast-${m}`;
    mast.position.set(0, H + mastH * 0.5, mastZ);
    mast.castShadow = true;
    group.add(mast);

    // Mast top cap
    const mastCap = new THREE.Mesh(new THREE.CylinderGeometry(mastR * 1.5, mastR * 1.2, 0.2, 8), darkMat);
    mastCap.position.set(0, H + mastH, mastZ);
    group.add(mastCap);

    const pennant = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15 - m * 0.12, 0.26),
      new THREE.MeshStandardMaterial({
        color: m === 0 ? ship.teamColor : 0xe8d8aa,
        emissive: m === 0 ? ship.teamColor : 0x000000,
        emissiveIntensity: m === 0 ? 0.18 : 0,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    pennant.position.set(0, H + mastH - 0.35, mastZ);
    group.add(pennant);
    pennants.push(pennant);

    // Crow's nest on the main mast — sits just ABOVE the sail's yard (sail top
    // settles at ~0.82·mastH) so the canvas hangs below it, not through it.
    // Keep in sync with getCrowNestStandingY (the standing spot).
    if (m === 0 && mastH > 6) {
      const nestY = getCrowNestStandingY(stats) - 0.12;
      planMast.nestY = nestY;
      // A genuine lookout platform, not a dinner plate: floor r = 1.0 carries
      // the server's 0.9 m walkable disc (PhysicsSystem CROW_NEST_WALK_RADIUS)
      // with the rail hoop just outboard at 1.06, so a pacing lookout stops at
      // the rail instead of at thin air. Named so the client can resolve it
      // (kept out of the static merge).
      const nestFloor = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.62, 0.16, 12), darkMat);
      nestFloor.name = 'nest-floor';
      nestFloor.position.set(0, nestY, mastZ);
      nestFloor.castShadow = true;
      nestFloor.receiveShadow = true;
      group.add(nestFloor);
      nestFloorMesh = nestFloor;
      // Staved basket: uprights + two hoops read as cooperage from the deck
      // and give the rim a real thickness to stand against.
      const nestRail = new THREE.Mesh(new THREE.TorusGeometry(1.06, 0.055, 6, 18), darkMat);
      nestRail.rotation.x = Math.PI * 0.5;
      nestRail.position.set(0, nestY + 0.52, mastZ);
      group.add(nestRail);
      const nestMidHoop = new THREE.Mesh(new THREE.TorusGeometry(1.03, 0.04, 6, 18), darkMat);
      nestMidHoop.rotation.x = Math.PI * 0.5;
      nestMidHoop.position.set(0, nestY + 0.26, mastZ);
      group.add(nestMidHoop);
      const staveCount = 12;
      for (let s = 0; s < staveCount; s++) {
        const a = (s / staveCount) * Math.PI * 2;
        const stave = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.6, 0.05), darkMat);
        stave.position.set(Math.sin(a) * 1.02, nestY + 0.3, mastZ + Math.cos(a) * 1.02);
        stave.rotation.y = a;
        group.add(stave);
      }
    }

    // Shrouds, deadeyes, ratlines and backstays: planRopes (b4.2h).

    for (const plan of mastPlan.sails) {
      if (plan.kind === 'spanker') continue;
      // Boom / yardarm — lives inside a trim pivot together with its sail and
      // furled roll, so bracing the sails visibly swings the SPAR too instead
      // of the canvas rotating away from a frozen yard.
      // ~12% narrower than round-1 (1.2 base) so the helm can see forward past the rig
      const yardW = plan.halfSpan * 2;
      const trimPivot = new THREE.Group();
      trimPivot.name = 'yard-trim-pivot';
      trimPivot.position.set(0, plan.headY, mastZ);
      group.add(trimPivot);
      trimPivots.push(trimPivot);
      const yard = new THREE.Mesh(
        new THREE.CylinderGeometry(plan.kind === 'course' ? 0.06 : 0.045, plan.kind === 'course' ? 0.06 : 0.045, yardW, 12),
        darkMat,
      );
      yard.rotation.z = Math.PI * 0.5;
      yard.castShadow = true;
      trimPivot.add(yard);

      // Lifts from the yardarm down to the deck. The upper end is ON the yard,
      // which lives in the trim pivot, so it is stored PIVOT-LOCAL: the yard is
      // a cylinder laid along the pivot's x axis at its origin, so the yardarm
      // is (±yardW·0.48, 0, 0) in that frame.
      yardHalfSpanForMast[trimPivots.length - 1] = yardW * 0.48;
      // b4.2h: lifts now run UP to a block on the mast (planRopes).
      planMast.yards.push({ pivot: trimPivot, halfSpan: yardW * 0.48, headY: plan.headY, kind: plan.kind });

      // Square-rigged sail — hangs from the yardarm. PlaneGeometry's default frame is
      // exactly what we want: width along X (matches yardarm direction), height along Y
      // (drops toward deck), normal along +Z (faces forward when "square" to wind).
      // The sail trim animation rotates around Y by `ship.sailAngle`.
      // The aftmost mast's canvas is what blocks the helm's forward view —
      // it narrows a further 10% on top of the global shrink.
      const sailW = Math.max(plan.headW, plan.footW);
      const sailH = plan.headY - plan.footY;
      // A topsail tapers from the course yard's spread at its foot to its own
      // shorter yard at the head; the grid carries the taper, the shader the shape.
      const [clothX, clothY] = sailClothGrid(quality);
      const sailGeo = makeSailClothGeometry(plan.headW, plan.footW, sailH, clothX, clothY);
      const mastSailMat = sailMat.clone();
      // Main sail carries the painted team band (team read at distance)
      if (m === 0 && plan.kind === 'course') mastSailMat.map = teamSailTexture(ship.teamColor);
      const clothPhase = mastZ + (plan.kind === 'topsail' ? 0.7 : 0);
      const sail = new THREE.Mesh(sailGeo, mastSailMat);
      sail.rotation.order = 'YXZ';
      sail.rotation.y = 0;
      // Pivot-local frame: the pivot sits AT the yard, so hoist metadata is
      // relative to it (hoistTopY = 0 = the yard height).
      // The head rides the yard; the shader gathers the cloth up to it when the
      // sail is part-hoisted, so the mesh never moves or scales for the hoist.
      sail.position.set(0, -sailH * 0.5, 0);
      sail.userData.hoistTopY = 0;
      sail.userData.hoistHeight = sailH;
      sail.userData.hoistCentered = true;
      sail.userData.sailKind = 'square';
      sail.userData.rigKind = plan.kind;
      sail.userData.trimPivot = trimPivot;
      sail.userData.phaseSeed = clothPhase;
      sail.userData.sailCloth = attachSailCloth(mastSailMat, plan.headW, plan.footW, sailH, clothPhase);
      sail.userData.clothFill = 0;
      sail.castShadow = false;
      sail.receiveShadow = false;
      addSwiftSailTrim(sail, sailW, sailH, upgradeVisuals.swift_sails);
      sail.userData.swiftTrim = sail.getObjectByName('upgrade-swift-sail-trim') ?? null;
      trimPivot.add(sail);
      sails.push(sail);

      // Furled canvas: a fat lashed BUNDLE gathered against the yard, not a
      // thin rod — an anchored ship must read as "sails stowed", not
      // dismasted. Slight vertical sag + gasket lashings sell the bundle.
      const furledGroup = new THREE.Group();
      // The bundle is a LATHE along the yard whose radius bulges between the
      // gaskets and pinches under them, and whose axis sags in a shallow
      // catenary — canvas gathered and strapped, not a length of white pipe.
      const gasketCount = 5;
      const bundleLen = yardW * 0.9;
      const bundleSegs = quality === 'low' ? 14 : 40;
      const bundleGeo = new THREE.CylinderGeometry(1, 1, bundleLen, quality === 'low' ? 8 : 12, bundleSegs, true);
      {
        // The mesh is rotated z=+90° below, so the cylinder's LOCAL +Y runs out
        // along the yard and LOCAL −X points DOWN in ship space — that is the
        // axis the bundle sags along.
        const pos = bundleGeo.attributes.position as THREE.BufferAttribute;
        const sag = 0.15;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          const u = y / bundleLen + 0.5;               // 0..1 along the yard
          // Pinch hard under each gasket, swell in the bays between them.
          const lash = Math.abs(Math.sin(u * Math.PI * gasketCount));
          const taper = 0.74 + 0.26 * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
          const r = (0.28 + 0.15 * lash) * taper;
          // Catenary over the whole yard + a droop in each bay between gaskets.
          const droop = sag * (1 - Math.pow(2 * u - 1, 2)) + 0.06 * lash;
          pos.setX(i, x * r - droop);
          pos.setZ(i, z * r);
        }
        bundleGeo.computeVertexNormals();
      }
      const bundleMat = sailMat.clone();
      // Stowed canvas is weathered and shaded, not showroom white — the audit
      // read the old bundles as bright white tubes on the yard.
      bundleMat.color.set(0xd9cda6);
      bundleMat.roughness = 0.95;
      // b4.2f: the bundle, its gaskets and their tails are ONE draw (vertex
      // colour tints the rope parts), so a course + topsail rig does not spend
      // 11 draws per yard on a stowed sail. bundleMat.color multiplies every
      // vertex colour: divide it out so the rope lands on the old 0x6b5836.
      const lowRig = quality === 'low';
      const gasketTone = new THREE.Color(0x6b5836);
      gasketTone.r /= bundleMat.color.r; gasketTone.g /= bundleMat.color.g; gasketTone.b /= bundleMat.color.b;
      const furledParts: THREE.BufferGeometry[] = [];
      const tint = (g: THREE.BufferGeometry, c: THREE.Color) => {
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        return g;
      };
      furledParts.push(tint(bundleGeo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI * 0.5)), new THREE.Color(1, 1, 1)));
      const partM = new THREE.Matrix4();
      const partQ = new THREE.Quaternion();
      const partE = new THREE.Euler();
      const unit = new THREE.Vector3(1, 1, 1);
      for (let g = -2; g <= 2; g++) {
        const gu = (g + 2) / (gasketCount - 1);
        const gasketY = -0.15 * (1 - Math.pow(2 * gu - 1, 2));
        const gx = g * bundleLen * 0.245;
        const gasket = new THREE.TorusGeometry(0.27, 0.034, lowRig ? 4 : 5, lowRig ? 8 : 12);
        gasket.applyMatrix4(partM.compose(new THREE.Vector3(gx, gasketY, 0), partQ.setFromEuler(partE.set(0, Math.PI * 0.5, 0)), unit));
        furledParts.push(tint(gasket, gasketTone));
        // Gasket tail hanging off the bundle — the giveaway that it is lashed.
        const tail = new THREE.CylinderGeometry(0.017, 0.013, 0.36, 5);
        tail.applyMatrix4(partM.compose(new THREE.Vector3(gx + 0.04, gasketY - 0.36, 0.02), partQ.setFromEuler(partE.set(0, 0, 0.16 * (g % 2 === 0 ? 1 : -1))), unit));
        furledParts.push(tint(tail, gasketTone));
      }
      const furledGeo = mergeGeometries(furledParts, false)!;
      for (const g of furledParts) g.dispose();
      bundleMat.vertexColors = true;
      const furled = new THREE.Mesh(furledGeo, bundleMat);
      furled.castShadow = true;
      furledGroup.add(furled);
      furledGroup.position.set(0, -Math.min(0.5, 0.25 + sailH * 0.03), -0.04);
      furledGroup.userData.rigKind = plan.kind;
      furledGroup.userData.phaseSeed = mastZ;
      furledGroup.scale.y = 1;
      trimPivot.add(furledGroup);
      furledSails.push(furledGroup as unknown as THREE.Mesh);
    }

    for (const plan of mastPlan.sails) {
      if (plan.kind !== 'spanker') continue;
      // Gaff spanker abaft the aft mast: boom at the course foot (over the
      // helmsman's head), gaff up to the peak, canvas fore-and-aft. Shape x
      // runs AFT (rotation.y = PI/2 maps local +x to -z), like the jib.
      const boomLen = plan.footW, gaffLen = plan.headW;
      const throatDy = (plan.headY - plan.footY) * 0.78;
      const peakDy = plan.headY - plan.footY;
      const boom = makeCylinderBetween(
        new THREE.Vector3(0, plan.footY, plan.zFore + 0.05),
        new THREE.Vector3(0, plan.footY, plan.zFore - boomLen - 0.2), 0.06, darkMat, 10);
      boom.castShadow = true;
      group.add(boom);
      const gaff = makeCylinderBetween(
        new THREE.Vector3(0, plan.footY + throatDy, plan.zFore + 0.05),
        new THREE.Vector3(0, plan.footY + peakDy, plan.zFore - gaffLen - 0.15), 0.05, darkMat, 10);
      gaff.castShadow = true;
      group.add(gaff);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(boomLen, 0);
      shape.lineTo(gaffLen, peakDy);
      shape.lineTo(0, throatDy);
      shape.lineTo(0, 0);
      const spanker = new THREE.Mesh(new THREE.ShapeGeometry(shape), sailMat.clone());
      spanker.rotation.order = 'YXZ';
      spanker.rotation.y = Math.PI * 0.5;
      spanker.position.set(0, plan.footY, plan.zFore);
      spanker.userData.hoistTopY = plan.footY + peakDy;
      spanker.userData.hoistHeight = peakDy;
      spanker.userData.hoistCentered = false;
      spanker.userData.sailKind = 'stay';
      spanker.userData.rigKind = 'spanker';
      spanker.userData.fixedYaw = Math.PI * 0.5;
      spanker.userData.phaseSeed = plan.zFore;
      spanker.castShadow = false;
      spanker.receiveShadow = false;
      addSwiftSailTrim(spanker, boomLen, peakDy, upgradeVisuals.swift_sails, true);
      group.add(spanker);
      sails.push(spanker);
    }
  }

  // Crow's nest ladder — vertical rails hug the main mast pole (x=0), not offset toward the rail edge
  {
    const mainMastZ = getMainMastLocalZ(stats);
    const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);
    const nestY = getCrowNestStandingY(stats);
    const ladderBottom = H + 0.2;
    const ladderTop = nestY + 0.02;
    const ladderH = Math.max(0.4, ladderTop - ladderBottom);
    const railMat = new THREE.MeshStandardMaterial({ map: darkWoodTex, roughness: 0.95 });
    const railW = 0.07;
    const mastOuter = mastR * 1.35 + 0.012;
    const railCenterX = mastOuter + railW * 0.5 + 0.018;
    for (const side of [-1, 1] as const) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(railW, ladderH + 0.12, 0.075),
        railMat,
      );
      rail.position.set(side * railCenterX, ladderBottom + ladderH * 0.5, mainMastZ + side * 0.015);
      rail.rotation.y = side * 0.06;
      rail.castShadow = true;
      group.add(rail);
    }
    const rungCount = 8;
    const rungSpan = railCenterX * 2 + railW * 0.45;
    for (let r = 0; r <= rungCount; r++) {
      const ry = ladderBottom + (r / rungCount) * ladderH;
      const rung = new THREE.Mesh(
        new THREE.BoxGeometry(rungSpan, 0.05, 0.088),
        deckMat,
      );
      rung.position.set(0, ry, mainMastZ);
      rung.castShadow = true;
      group.add(rung);
    }
    // b3.3c: rung grips for the climber's hand IK (both ends of every rung).
    const ladderGrips = new THREE.Object3D();
    ladderGrips.name = 'mast-ladder-grips';
    ladderGrips.userData[IK_GRIPS_KEY] = { kind: 'ladder', points: Array.from({ length: (rungCount + 1) * 2 }, (_, i) => new THREE.Vector3((i % 2 ? 1 : -1) * rungSpan * 0.3, ladderBottom + (Math.floor(i / 2) / rungCount) * ladderH, mainMastZ)) };
    group.add(ladderGrips);
  }

  // Shared centerline sail ring, separated from side cannon click zones and anchor capstan.
  {
    const markerMat = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1, side: THREE.DoubleSide });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xa8792a, roughness: 0.55, metalness: 0.55 });
    // Rail rope stations (SoT braces): worked from the bulwarks on BOTH
    // sides — coiled halyard rope on a belaying rack, tail dropping from
    // the rigging above. The floating deck-ring station is gone.
    const ropeStationMat = new THREE.MeshStandardMaterial({ color: 0xb99e6a, roughness: 0.95 });
    const mastHForHalyard = getMastHeight(stats);
    // The yard a brace actually swings: the pivot nearest the main mast. The
    // mast loop has already run, so trimPivots is complete here.
    const mainMastLocalZForBrace = getMainMastLocalZ(stats);
    let mainTrimPivot: THREE.Group | null = null;
    let mainYardHalfSpan = 0;
    for (let i = 0; i < trimPivots.length; i++) {
      if (mainTrimPivot === null
        || Math.abs(trimPivots[i].position.z - mainMastLocalZForBrace)
           < Math.abs(mainTrimPivot.position.z - mainMastLocalZForBrace)) {
        mainTrimPivot = trimPivots[i];
        mainYardHalfSpan = yardHalfSpanForMast[i] ?? 0;
      }
    }
    mainTrimPivotForPlan = mainTrimPivot;
    for (const ropeStation of getSailRopeStationLocals(stats)) {
      // Clamp the rack onto the REAL deck at this station — the hull
      // narrows toward the mast, and the shared approximation can land a
      // few dm outboard of the loft (racks floated in mid-air off the bow).
      const deckEdge = Math.abs(hullSurfacePointAt(profile, ropeStation.z, H * 0.9).x);
      const sx = Math.sign(ropeStation.x);
      const rackX = sx * Math.min(Math.abs(ropeStation.x), Math.max(0.9, deckEdge - 0.5));
      const rack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.16), markerMat);
      rack.position.set(rackX, H + 0.78, ropeStation.z);
      rack.castShadow = true;
      group.add(rack);
      for (const pinOff of [-0.3, 0, 0.3]) {
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.035, 0.34, 6), brassMat);
        pin.name = 'belaying-pin';
        pin.position.set(rackX + pinOff, H + 0.68, ropeStation.z);
        group.add(pin);
      }
      // Halyard hanks hung on the pin rail — irregular flaked coils with a
      // tail, not machined donuts (deck-dressing audit).
      const coil = makeRopeCoil(ropeStationMat, 0.21, 0.07, ropeStation.z * 7 + 1, 2.4);
      coil.rotation.z = Math.PI * 0.5;
      coil.position.set(rackX, H + 0.5, ropeStation.z + 0.02);
      group.add(coil);
      const coil2 = makeRopeCoil(ropeStationMat, 0.17, 0.055, ropeStation.z * 5 + 4, 2.1);
      coil2.rotation.z = Math.PI * 0.5;
      coil2.position.set(rackX + 0.02, H + 0.46, ropeStation.z - 0.12);
      group.add(coil2);
      // The stations sit abeam the mainmast, so the halyard runs from the
      // pin rail UP to the yard — the rope you haul visibly leads to the
      // sail it moves (taut both ends, no floating tail, no text tag).
      // Halyard: pin rail up to a block ON THE MAST, not on the yard, so it
      // is static by design — hauling it hoists the sail, it does not brace.
      // Made fast ON the drawn mast nearest the shared main-mast z (the
      // shared z and the drawn mast can differ by a few dm).
      const mainZ = getMainMastLocalZ(stats);
      const pm = planMasts.reduce((best, mm) => (Math.abs(mm.z - mainZ) < Math.abs(best.z - mainZ) ? mm : best), planMasts[0]);
      const halyardY = H + Math.min(mastHForHalyard, pm.height) * 0.55;
      const hr = mastR * (1.4 - 0.6 * ((halyardY - H) / pm.height)) * 0.9;
      ropeRuns.push({
        a: new THREE.Vector3(rackX, H + 0.72, ropeStation.z),
        b: new THREE.Vector3(Math.sign(rackX) * hr, halyardY, pm.z),
        family: 'running', aKind: 'pin', bKind: 'spar', label: 'station-halyard',
      });
    }
    // Brace stations: cleat + coil at the quarterdeck rails, brace rope
    // running up to the yard END on that side — the physical "angle the
    // sails" handle ([X] hold sweeps the yard toward that rail).
    for (const brace of getBraceStationLocals(stats)) {
      const deckEdge = Math.abs(hullSurfacePointAt(profile, brace.z, H * 0.9).x);
      const bx = Math.sign(brace.x) * Math.min(Math.abs(brace.x), Math.max(0.9, deckEdge - 0.5));
      const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.14), markerMat);
      cleat.position.set(bx, H + 0.74, brace.z);
      cleat.name = 'brace-cleat';
      cleat.castShadow = true;
      group.add(cleat);
      const braceCoil = makeRopeCoil(ropeStationMat, 0.18, 0.06, brace.z * 3 + 2, 2.3);
      braceCoil.rotation.z = Math.PI * 0.5;
      braceCoil.position.set(bx, H + 0.48, brace.z);
      group.add(braceCoil);
      // THE BRACE ACTUALLY REACHES THE YARD NOW (ships-16). Its own comment
      // said "running up to the yard END on that side" while the drawn line
      // stopped at a fixed point beside the mast, so the one rope the player
      // hauls to swing the spar was the one rope that never moved with it.
      const braceSide = Math.sign(brace.x);
      ropeRuns.push({
        a: new THREE.Vector3(bx, H + 0.7, brace.z),
        b: mainTrimPivot
          ? new THREE.Vector3(braceSide * mainYardHalfSpan, mainTrimPivot.position.y, mainTrimPivot.position.z)
          : new THREE.Vector3(braceSide * L * 0.2, H + mastHForHalyard * 0.6, getMainMastLocalZ(stats)),
        pivot: mainTrimPivot ?? undefined,
        bLocal: mainTrimPivot ? new THREE.Vector3(braceSide * mainYardHalfSpan, 0, 0) : undefined,
        family: 'running', sag: mainTrimPivot ? 0.02 : 0, aKind: 'pin', bKind: 'spar', label: 'station-brace',
      });
    }
  }

  // Forward jib — a triangular headsail whose LUFF runs along the forestay from
  // the bowsprit tip (forward + low) up to the foremast (aft + high), so the
  // canvas hugs the rig instead of floating as a vertical slab above the bow.
  // (Local X → world -Z after the y=90° rotation; local Y → world Y.)
  // Forestay to the fore course yard (b4.2f): the jib grows with the rig.
  const foreStayHeadY = H + rigPlan[0].height * 0.55;
  const jibHeadH = (foreStayHeadY - (H + 0.52)) * 0.9;
  const jibShape = new THREE.Shape();
  jibShape.moveTo(-L * 0.20, 0);        // tack — at the bowsprit tip (world z≈L*0.76)
  jibShape.lineTo(L * 0.26, H * 0.30);  // clew — aft + low (sheet corner, the belly)
  jibShape.lineTo(L * 0.28, jibHeadH);  // head — up the foremast (world z≈L*0.28)
  jibShape.lineTo(-L * 0.20, 0);
  const jib = new THREE.Mesh(new THREE.ShapeGeometry(jibShape), sailMat.clone());
  jib.rotation.order = 'YXZ';
  // Jib is a stay-sail running on the centerline (YZ plane), so its plane normal
  // points sideways. It does NOT trim with the yardarm sails — fixed yaw.
  jib.rotation.y = Math.PI * 0.5;
  jib.position.set(0, H + 0.52, L * 0.56);
  jib.userData.hoistTopY = H + 0.52 + jibHeadH;
  jib.userData.hoistHeight = jibHeadH;
  jib.userData.hoistCentered = false;
  jib.userData.sailKind = 'stay';
  jib.userData.fixedYaw = Math.PI * 0.5;
  jib.userData.phaseSeed = L * 0.56;
  jib.castShadow = false;
  jib.receiveShadow = false;
  addSwiftSailTrim(jib, L * 0.24, jibHeadH, upgradeVisuals.swift_sails, true);
  group.add(jib);
  sails.push(jib);
  // Furled jib bundle lies ALONG the forestay (bowsprit tip → foremast head),
  // axis exactly on the stay so it reads as canvas lashed to it.
  const stayTip = new THREE.Vector3(0, H + 0.55, L * 0.76);
  const stayHead = new THREE.Vector3(0, foreStayHeadY, mastStartZ);
  const stayDir = stayHead.clone().sub(stayTip).normalize();
  const furledJib = makeCylinderBetween(
    stayTip.clone().addScaledVector(stayDir, 0.2),
    stayTip.clone().addScaledVector(stayDir, 0.2 + L * 0.34),
    0.05,
    sailMat.clone(),
    8,
  );
  furledJib.userData.phaseSeed = L * 0.66;
  group.add(furledJib);
  furledSails.push(furledJib);

  // Head stays (b4.2h): from points ON the bowsprit's axis (read from the
  // spar ShipRenderer built, tagged userData.rigSpar) up the foremast.
  const foreMastZ = mastStartZ;
  const bowsprit = group.children.find((o) => o.userData.rigSpar === 'bowsprit') as THREE.Mesh | undefined;
  const sprit = (alongFromTip: number): THREE.Vector3 => {
    if (!bowsprit) return new THREE.Vector3(0, H + 0.55, L * 0.76 - alongFromTip);
    bowsprit.updateMatrix();
    const half = ((bowsprit.geometry as THREE.CylinderGeometry).parameters?.height ?? L * 0.33) * 0.5;
    const p = new THREE.Vector3(0, half - alongFromTip, 0).applyMatrix4(bowsprit.matrix);
    const q = new THREE.Vector3(0, -half + alongFromTip, 0).applyMatrix4(bowsprit.matrix);
    return p.z > q.z ? p : q;
  };
  const foreR = (y: number) => mastR * (1.4 - 0.6 * THREE.MathUtils.clamp((y - H) / rigPlan[0].height, 0, 1)) * 0.9;
  ropeRuns.push({
    a: sprit(0.12), b: new THREE.Vector3(0, foreStayHeadY, foreMastZ + foreR(foreStayHeadY)),
    family: 'standing', aKind: 'spar', bKind: 'spar', label: 'forestay',
  });
  // Side stays land ON the bowsprit shaft just behind the tip — never in open air
  for (const sx of [-1, 1] as const) {
    ropeRuns.push({
      a: sprit(L * 0.04), b: new THREE.Vector3(sx * foreR(foreStayHeadY - 0.4), foreStayHeadY - 0.4, foreMastZ),
      family: 'standing', aKind: 'spar', bKind: 'spar', label: 'head-stay',
    });
  }
  const foreTopY = (planMasts[0]?.nestY ?? (H + rigPlan[0].height)) - 0.45;
  ropeRuns.push({
    a: sprit(0.05), b: new THREE.Vector3(0, foreTopY, foreMastZ + foreR(foreTopY)),
    family: 'standing', aKind: 'spar', bKind: 'spar', label: 'fore-topmast-stay',
  });
  const plan = planRopes({
    profile, H, L, type: ship.type, ratlineStep: ctx.phone ? 1.14 : quality === 'low' ? 0.76 : 0.38,
    masts: planMasts, bracedPivot: mainTrimPivotForPlan,
  });
  ropeRuns.push(...plan.ropes);
  ratlineRuns.push(...plan.ratlines);

  // Flush all collected rigging into two INSTANCED draw calls. Three radial
  // sides on the low tier, five elsewhere: ~290 triangles per hull on low,
  // ~480 on balanced — under a tenth of a percent of the wide-shot budget,
  // and the draw-call count is identical to the two LineSegments it replaces.
  // Phones (b4.2h): a DoubleSide ribbon (2 tris; the old 2-sided cylinder
  // was the same quad twice at 4 tris), only the
  // deadeyes and blocks among the fittings, no lanyards (the deadeye pair
  // reads as one fitting at phone size), slack lines in 3 segments and a
  // ratline every 1.14 m, to hold the 45k phone own-hull cap with the rig
  // root counted (galleon 46,191 -> under 45,000).
  const ropeSides = ctx.phone ? 1 : quality === 'low' ? 3 : 5;
  if (ctx.phone) plan.hardware = plan.hardware.filter((f) => f.kind === 'deadeye' || f.kind === 'block');
  const ropeRunsBuilt = ctx.phone ? ropeRuns.filter((r) => r.label !== 'lanyard') : ropeRuns;
  const slackSegs = ctx.phone ? SLACK_SEGMENTS_PHONE : SLACK_SEGMENTS;
  const ropeRigMat = new THREE.MeshStandardMaterial({ color: 0x6a5030, roughness: 1 });
  ropeRigMat.name = 'ship-rigging-rope';
  const ratlineRigMat = new THREE.MeshStandardMaterial({ color: 0x4b3520, roughness: 1 });
  ratlineRigMat.name = 'ship-rigging-ratline';
  if (ctx.phone) { ropeRigMat.side = THREE.DoubleSide; ratlineRigMat.side = THREE.DoubleSide; }
  const ropeRig = buildRigging(ropeRunsBuilt, ropeRigMat, 0.028, ropeSides, plan.hardware, slackSegs);
  const ratlineRig = buildRigging(ratlineRuns, ratlineRigMat, 0.018, ropeSides, [], slackSegs);
  const rigSet: RiggingSet | null = ropeRig && ratlineRig
    ? { rope: ropeRig, ratline: ratlineRig, far: buildRigFarCards(plan.cards, 0x4b3520) }
    : null;

  return { sails, furledSails, pennants, trimPivots, nestFloorMesh, mastCount, mastStartZ, ropeRig, ratlineRig, rigSet };
}
