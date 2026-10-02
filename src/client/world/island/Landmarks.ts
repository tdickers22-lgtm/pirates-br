/**
 * What people left behind: the lookout post, the pirate camp, the idol cluster,
 * a rope cliff ladder, the second beached wreck, the packed-dirt trail network
 * between the island's stops, the rope bridges between peaks, and the ruin.
 */
import * as THREE from 'three';
import { assets } from '../../assets/AssetLibrary.js';
import { CLIMB_STANDOFF_M, climbLength, climbPointAt, islandClimbs } from '../../../shared/interactions.js';
import { getBridgeSpanY, getIslandSurfaceY } from '../../../shared/utils/index.js';
import { MAX_METALNESS_NO_ENV, MIN_ALBEDO_VALUE } from '../../assets/materialAudit.js';
import type { IslandBuildCtx } from './context.js';
import { getMeshGround, snapToDrawnGround } from './GroundTruth.js';

/**
 * A hand-authored prop material that obeys the SHIPPED-ASSET material rule.
 *
 * `materialAudit.ts` documents why a near-black albedo and a high metalness both
 * collapse a prop to a featureless silhouette in this scene — the AgX toe crushes
 * anything under ~0.08 linear, and with no PMREM/envMap anywhere in the renderer a
 * metal has its diffuse lobe multiplied out and gets nothing back. But that audit
 * runs inside AssetLibrary, over the 56 shipped GLBs. Materials built by hand in
 * the island builders never pass through it, so the rule simply did not apply to
 * them — which is how the camp cookpot came to be authored at 0x161616 (0.008
 * linear, TEN TIMES under the documented floor) with metalness above the ceiling,
 * and photographed at noon as a pure-black hole in the hillside with no shading
 * gradient at all.
 *
 * This is the same rule with a hand-authored entry point: assert the floor rather
 * than silently repairing it, so a value that breaks it fails loudly at build time
 * instead of shipping as a black prop. Emissive-driven materials (embers, lantern
 * glass) are deliberately NOT run through here — their read comes from the glow,
 * not the albedo.
 */
function litPropMaterial(params: {
  color: number; roughness: number; metalness?: number; flatShading?: boolean;
}): THREE.MeshStandardMaterial {
  const color = new THREE.Color(params.color);
  const peak = Math.max(color.r, color.g, color.b);
  if (peak < MIN_ALBEDO_VALUE) {
    throw new Error(
      `litPropMaterial: 0x${params.color.toString(16).padStart(6, '0')} is ${peak.toFixed(4)} linear, `
      + `under the ${MIN_ALBEDO_VALUE} floor — it will render as a black silhouette (see materialAudit).`,
    );
  }
  const metalness = Math.min(params.metalness ?? 0, MAX_METALNESS_NO_ENV);
  return new THREE.MeshStandardMaterial({
    color, roughness: params.roughness, metalness, flatShading: params.flatShading ?? false,
  });
}

/**
 * The ground THESE landmarks stand on: the drawn terrain mesh, island-local.
 *
 * Every structure in this file used to seat its feet on `getIslandSurfaceY` —
 * the analytic heightfield the mesh is only a chord approximation OF. The mesh
 * therefore runs BELOW the function wherever the field is convex, and a
 * lookout's legs, a camp's fire ring or an idol's plinth ended up hovering
 * over the hillside the player is actually looking at. Falls back to the
 * analytic answer on the low-detail proxy path, where there is no mesh yet.
 */
function drawnGroundAt(ctx: IslandBuildCtx, localX: number, localZ: number): number {
  const y = getMeshGround(ctx.island)?.heightAt(localX, localZ);
  return y ?? getIslandSurfaceY(ctx.island, localX + ctx.island.position.x, localZ + ctx.island.position.z);
}

/** Lookout post — wooden tower on or near a high point. */
export function buildLookoutPost(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, SURFACE_ABOVE_WATER } = ctx;
  if (!lowDetail && r > 40) {
    const lookout = new THREE.Group();
    // A lookout platform IS elevated by design; its LEGS are not, so the whole
    // piece is claimed by the grounding audit and the legs below must reach.
    lookout.name = 'decor-lookout';
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
        // Local (sx*0.7, sz*0.7) in lookout space → island-local position
        const lx = base.x + (sx * legOffset * cosY + sz * legOffset * sinY);
        const lz = base.z + (-sx * legOffset * sinY + sz * legOffset * cosY);
        // …and each foot lands on the DRAWN hillside, a fingerbreadth into it.
        legPositions.push({ sx, sz, surfaceY: drawnGroundAt(ctx, lx, lz) - 0.12 });
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
}

/** Pirate camp — fire pit, bedrolls, totem, hung skull. */
export function buildPirateCamp(ctx: IslandBuildCtx) {
  const {
    host, island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint,
    islandSeed, SURFACE_ABOVE_WATER, boulderGeo, buildPropInstance,
  } = ctx;
  if (!lowDetail && r > 38) {
    const camp = new THREE.Group();
    camp.name = 'decor-camp';
    const angle = island.profile.secondaryHillAngle + (rng(islandSeed * 113) - 0.5) * 0.8;
    const distRatio = 0.28 + rng(islandSeed * 127) * 0.24;
    const base = surfacePoint(distRatio, angle, 0);
    snapToDrawnGround(getMeshGround(island), base);
    const campYaw = rng(islandSeed * 131) * Math.PI * 2;
    camp.position.copy(base);
    camp.rotation.y = campYaw;
    const cosCY = Math.cos(campYaw);
    const sinCY = Math.sin(campYaw);
    const groundOffsetAt = (lx: number, lz: number) => {
      // Camp-local → island-local, then onto the drawn hillside.
      return drawnGroundAt(
        ctx,
        base.x + (lx * cosCY + lz * sinCY),
        base.z + (-lx * sinCY + lz * cosCY),
      ) - base.y;
    };
    // Every hue below is the ORIGINAL authored hue, scaled in linear space until
    // its peak channel clears the documented 0.08 floor (see litPropMaterial):
    // 0x3d352b was 0.047 and 0x2a1a0c was 0.023, so the fire-ring stones, the
    // criss-crossed logs, the totem and the tripod were all sitting two to four
    // times under the value at which this scene's tonemap still resolves shading.
    // The embers keep their char albedo — an ember is read by its glow, and that
    // is what `emissive` is for.
    const stoneMatC = litPropMaterial({ color: 0x53483c, roughness: 1 });
    const charredMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 1, emissive: 0x6b2a06, emissiveIntensity: 0.4 });
    const logMatC = litPropMaterial({ color: 0x53371f, roughness: 1 });
    // Fire pit: GLB stone ring + charred logs when available (interim — a
    // later pass moves camp placement to the server prop registry).
    const campfireGlb = buildPropInstance(
      'campfire',
      new THREE.Vector3(0, 0.02, 0),
      rng(islandSeed * 151) * Math.PI * 2,
      1.15,
    );
    if (campfireGlb) {
      camp.add(campfireGlb);
    } else {
      // Fire ring — each stone seated on the terrain under it (the flat 0.18
      // ring floated on the downhill side of a sloped campsite).
      for (let s = 0; s < 8; s++) {
        const a = (s / 8) * Math.PI * 2;
        const stone = new THREE.Mesh(boulderGeo, stoneMatC);
        const slx = Math.cos(a) * 0.8;
        const slz = Math.sin(a) * 0.8;
        stone.position.set(slx, groundOffsetAt(slx, slz) + 0.14, slz);
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
    host.registerLanternEmitter(camp, 0, 0.42, 0, 'campfire');

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
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), litPropMaterial({ color: 0x53372d, roughness: 1 }));
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
    // Cookpot — sits on the ground next to fire.
    //
    // This is the prop the graphics audit photographed as "pure black with no
    // shading". It was authored at 0x161616 — 0.008 linear, an order of magnitude
    // under the floor this scene's tonemap needs — with metalness 0.4 over the
    // no-envMap ceiling, so its diffuse lobe was partly multiplied out and there
    // was no environment left to give anything back. Sooty cast iron instead: the
    // albedo clears the floor, the metalness sits at the ceiling, and roughness
    // comes down off 0.95 so the sun actually lays a broad sheen along the belly
    // rather than a uniform Lambert nothing.
    const potY = groundOffsetAt(1.4, 0.4);
    const potMat = litPropMaterial({ color: 0x554f48, roughness: 0.62, metalness: 0.35 });
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.5, 12), potMat);
    pot.position.set(1.4, potY + 0.34, 0.4);
    pot.castShadow = true;
    pot.receiveShadow = true;
    camp.add(pot);
    // A cylinder alone reads as a bucket at any range. The lip ring is what says
    // "cast iron": it catches the sun on its top curve while the belly falls away,
    // which is the one highlight that makes the silhouette a pot.
    const potRim = new THREE.Mesh(new THREE.TorusGeometry(0.345, 0.045, 6, 12), potMat);
    potRim.rotation.x = Math.PI * 0.5;
    potRim.position.set(1.4, potY + 0.58, 0.4);
    potRim.castShadow = true;
    camp.add(potRim);
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
}

/** Stone idol cluster — three carved tiki-style faces. */
export function buildStoneIdols(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, SURFACE_ABOVE_WATER } = ctx;
  if (!lowDetail && r > 50) {
    const idolMat = new THREE.MeshStandardMaterial({ color: 0x4a4338, roughness: 1, flatShading: true });
    const idolEyeMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 1, emissive: 0x6b1a06, emissiveIntensity: 0.3 });
    const idolAngle = island.profile.tertiaryHillAngle + (rng(islandSeed * 311) - 0.5) * 0.6;
    const cluster = new THREE.Group();
    cluster.name = 'decor-idols';
    const clusterCenter = surfacePoint(0.34 + rng(islandSeed * 313) * 0.18, idolAngle, 0);
    snapToDrawnGround(getMeshGround(island), clusterCenter);
    cluster.position.copy(clusterCenter);
    cluster.rotation.y = idolAngle + Math.PI;
    for (let i = 0; i < 3; i++) {
      const ix = (i - 1) * 1.4;
      const iz = (i - 1) * 0.3 + (rng(i * 317 + islandSeed) - 0.5) * 0.4;
      const groundY = drawnGroundAt(ctx, clusterCenter.x + ix, clusterCenter.z + iz) - clusterCenter.y - 0.1;
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
}

/** b4.7b: the island's climb routes (island.climbs, placed by the static
 *  world), built along the same draped polyline the server pins climbers to.
 *  The old decorative ladder (random site, no server presence) is gone.
 *  Ladders: two round rails 0.48 m apart with rungs every 0.32 m of arc and
 *  rail ends standing 0.9 m proud of the top as handholds. Ropes: one knotted
 *  hawser (a knot every 0.45 m) tied off to a stake on the top. Scrambles: a
 *  fixed hand line on short stakes beside the rock steps, so the route reads
 *  from the beach. Everything merges into one wood mesh and one rope mesh per
 *  island (2 draws), geometry in island-local space. */
const CLIMB_RUNG_STEP_M = 0.32;
const CLIMB_RAIL_HALF_M = 0.24;
const CLIMB_KNOT_STEP_M = 0.45;
export function buildRopeLadder(ctx: IslandBuildCtx) {
  const { island, group, lowDetail } = ctx;
  const routes = islandClimbs(island);
  if (routes.length === 0) return;
  const ox = island.position.x; const oy = island.position.y; const oz = island.position.z;
  // One instance matrix list per climb_kit.glb node (scripts/blender/build_poi_kit.py).
  const parts = new Map<ClimbKitNode, THREE.Matrix4[]>(CLIMB_KIT_NODES.map((n) => [n, []]));
  const UP = new THREE.Vector3(0, 1, 0); const ACROSS = new THREE.Vector3(1, 0, 0);
  const dir = new THREE.Vector3(); const q = new THREE.Quaternion();
  const put = (node: ClimbKitNode, pos: THREE.Vector3, rot: THREE.Quaternion, sx: number, sy: number, sz: number): void => {
    parts.get(node)!.push(new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(sx, sy, sz)));
  };
  // A unit node along +Y from `a` to `b` (rail, rope), radius scaled by `rs`.
  const seg = (node: ClimbKitNode, a: THREE.Vector3, b: THREE.Vector3, rs = 1): void => {
    dir.subVectors(b, a);
    const len = dir.length();
    if (len < 1e-3) return;
    put(node, a, q.setFromUnitVectors(UP, dir.multiplyScalar(1 / len)).clone(), rs, len, rs);
  };
  const rung = (a: THREE.Vector3, b: THREE.Vector3): void => {
    dir.subVectors(b, a);
    const len = dir.length();
    put('climb_rung', a.clone().add(b).multiplyScalar(0.5), q.setFromUnitVectors(ACROSS, dir.multiplyScalar(1 / len)).clone(), len, 1, 1);
  };
  const knot = (p: THREE.Vector3, along: THREE.Vector3): void => {
    put('climb_knot', p, q.setFromUnitVectors(UP, along.clone().normalize()).clone(), 1, 1, 1);
  };
  // Stake from 0.25 m below (x, y, z) to h above it; the node is unit radius and length.
  const stake = (x: number, y: number, z: number, h: number, r: number): void => {
    put('climb_stake', new THREE.Vector3(x, y - 0.25, z), new THREE.Quaternion(), r, h + 0.25, r);
  };
  for (const c of routes) {
    const len = climbLength(c);
    const px = -c.nz; const pz = c.nx; // across the face
    // Island-local point on the route `out` metres off the FACE (the draped
    // polyline, not the body: climbPointAt's standoff tapers to 0 at the ends
    // and would bury the rails there), `side` across it. The drawn terrain is a
    // chord mesh that runs proud of the analytic face at a concave foot, so the
    // point then steps out along the normal until it clears the drawn ground.
    const at = (t: number, out: number, side: number, lift = 0): THREE.Vector3 => {
      const p = climbPointAt(c, t);
      const u = Math.max(0, Math.min(1, t));
      const back = CLIMB_STANDOFF_M * Math.min(1, u * 6, (1 - u) * 6) - out;
      let x = p.x - ox - c.nx * back + px * side; let z = p.z - oz - c.nz * back + pz * side;
      const y = p.y - oy + lift;
      for (let k = 0; k < 30 && drawnGroundAt(ctx, x, z) > y - 0.06; k++) { x += c.nx * 0.08; z += c.nz * 0.08; }
      return new THREE.Vector3(x, y, z);
    };
    const n = Math.max(2, Math.ceil(len / 0.5));
    if (c.kind === 'ladder') {
      for (const s of [-CLIMB_RAIL_HALF_M, CLIMB_RAIL_HALF_M]) {
        for (let i = 0; i < n; i++) seg('climb_rail', at(i / n, 0.12, s, 0.05), at((i + 1) / n, 0.12, s, 0.05));
        const top = at(1, 0.12, s, 0.05);
        seg('climb_rail', top, top.clone().setY(top.y + 0.9));
      }
      const rungs = Math.max(1, Math.floor(len / CLIMB_RUNG_STEP_M));
      for (let i = 1; i < rungs; i++) {
        const t = i / rungs;
        rung(at(t, 0.12, -CLIMB_RAIL_HALF_M - 0.04, 0.05), at(t, 0.12, CLIMB_RAIL_HALF_M + 0.04, 0.05));
      }
    } else if (c.kind === 'rope') {
      for (let i = 0; i < n; i++) seg('climb_rope', at(i / n, 0.1, 0, 0.05), at((i + 1) / n, 0.1, 0, 0.05));
      const knots = Math.floor(len / CLIMB_KNOT_STEP_M);
      for (let i = 1; i < knots; i++) {
        const t = i / knots;
        knot(at(t, 0.1, 0, 0.05), at(Math.min(1, t + 0.02), 0.1, 0, 0.05).sub(at(Math.max(0, t - 0.02), 0.1, 0, 0.05)));
      }
      const top = at(1, 0, 0, 0);
      stake(top.x - c.nx * 0.6, top.y, top.z - c.nz * 0.6, 0.7, 0.07);
      seg('climb_rope', at(1, 0.1, 0, 0.05), new THREE.Vector3(top.x - c.nx * 0.6, top.y + 0.55, top.z - c.nz * 0.6));
    } else {
      // Scramble: hand line 0.9 m up, 0.7 m beside the step line.
      for (let i = 0; i < n; i++) seg('climb_rope', at(i / n, 0, 0.7, 0.9), at((i + 1) / n, 0, 0.7, 0.9), 0.8);
      const posts = Math.max(1, Math.ceil(len / 4));
      for (let i = 0; i <= posts; i++) {
        const p = at(i / posts, 0, 0.7, 0);
        stake(p.x, p.y, p.z, 0.95, 0.05);
      }
    }
  }
  for (const [node, list] of parts) {
    if (!list.length) continue;
    // The Blender kit node; the low-detail proxy path (and a kit that failed to load) draws the
    // same matrices on a 4-sided stand-in so the route never vanishes.
    const kit = lowDetail ? null : assets.mergedNodeGeometry('climb_kit', node);
    if (!kit && !lowDetail) console.warn(`[climb] climb_kit.glb node ${node} not loaded: ${island.id} draws the stand-in`);
    const standIn = kit ? null : climbStandIn(node);
    const inst = new THREE.InstancedMesh((kit ?? standIn)!.geometry, (kit ?? standIn)!.material, list.length);
    list.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.name = `climb-${node}`;
    inst.castShadow = !lowDetail;
    inst.receiveShadow = true;
    group.add(inst);
  }
}

const CLIMB_KIT_NODES = ['climb_rail', 'climb_rung', 'climb_rope', 'climb_knot', 'climb_stake'] as const;
type ClimbKitNode = (typeof CLIMB_KIT_NODES)[number];
/** Unit stand-in for a kit node in the GLB node's frame (see build_poi_kit.py); owned by its mesh. */
function climbStandIn(node: ClimbKitNode): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  let g: THREE.BufferGeometry;
  if (node === 'climb_rung') g = new THREE.CylinderGeometry(0.03, 0.03, 1, 4, 1, true).rotateZ(Math.PI / 2);
  else if (node === 'climb_knot') g = new THREE.SphereGeometry(0.075, 4, 3);
  else if (node === 'climb_stake') g = new THREE.CylinderGeometry(1, 1, 1, 4, 1).translate(0, 0.5, 0);
  else {
    const r = node === 'climb_rail' ? 0.045 : 0.035;
    g = new THREE.CylinderGeometry(r, r, 1, 4, 1, true).translate(0, 0.5, 0);
  }
  const wood = node === 'climb_rail' || node === 'climb_rung' || node === 'climb_stake';
  return { geometry: g, material: litPropMaterial(wood ? { color: 0x8a6a44, roughness: 0.85 } : { color: 0xb89c68, roughness: 0.95 }) };
}

/** Secondary smaller wreck on bigger islands so they feel storied. (Skipped
 *  when the server registry already placed a shipwreck landmark — two wrecks on
 *  one beach reads as a bug, not a story.) */
export function buildSecondaryWreck(ctx: IslandBuildCtx) {
  const {
    island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint,
    islandSeed, islandHeading, SURFACE_ABOVE_WATER, buildPropInstance,
  } = ctx;
  const hasRegistryWreck = (island.props ?? []).some((prop) => prop.type === 'shipwreck');
  if (!lowDetail && r > 64 && island.tavern === null && !hasRegistryWreck) {
    const wAngle = islandHeading + Math.PI * 1.45 + rng(islandSeed * 999) * 0.5;
    const wPos = surfacePoint(0.85 + rng(islandSeed * 1003) * 0.06, wAngle, 0);
    const wreck2Solid = isSolidDecorPoint(wPos, SURFACE_ABOVE_WATER, -0.15);
    snapToDrawnGround(getMeshGround(island), wPos, -0.1);
    const wreck2Glb = wreck2Solid
      ? buildPropInstance('shipwreck', wPos, -wAngle + Math.PI * 0.4, 0.5)
      : null;
    if (wreck2Glb) {
      wreck2Glb.rotation.z = (rng(islandSeed * 1009) - 0.5) * 0.24;
      group.add(wreck2Glb);
    } else if (wreck2Solid) {
    const wreck2 = new THREE.Group();
    wreck2.name = 'decor-wreck-section';
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
      const lY = drawnGroundAt(ctx, wPos.x + lx, wPos.z + lz) - wPos.y;
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
}

/** Trails — packed-dirt paths between dock, tavern, upgrade stations, hoarder
 *  and ruins. */
export function buildTrails(ctx: IslandBuildCtx) {
  const { island, group, rng, lowDetail, boulderGeo } = ctx;
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
      // Every tile and kerb stone used to be its own Mesh — ~500 draw calls
      // scene-wide for the path network alone. Collect transforms and emit two
      // InstancedMeshes per island instead (unit box + shared decor boulder).
      const tileXf: THREE.Matrix4[] = [];
      const kerbXf: THREE.Matrix4[] = [];
      const trM = new THREE.Matrix4();
      const trP = new THREE.Vector3();
      const trQ = new THREE.Quaternion();
      const trE = new THREE.Euler();
      const trS = new THREE.Vector3();
      const trObj = new THREE.Object3D();

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
          // AUDIT P1/P2: each tile was a 0.08m slab dropped flat at ONE centre
          // sample, so on any grade its downhill edge cantilevered into open
          // air and the run read as a jagged staircase of floating pavers.
          // Now: sampled at the four corners, pitched into the local slope,
          // thickened into a stone kerb and sunk so the downhill edge is
          // swallowed by the ground (the thickness IS the downhill skirt).
          //
          // …and those corner samples came off the ANALYTIC field, which is the
          // last version of this bug rather than the fix. The trail's whole job
          // is to hug a hillside, so it runs exactly where the polar mesh is a
          // chord UNDER the function it was sampled from — every convex ridge
          // the path crosses lifted the pavers off the ground the player is
          // looking at. The kerb stones beside them were pinned to the drawn
          // mesh two waves ago and the tiles were left behind, so on a ridge
          // the border stones sat below their own path. Corners are now drawn
          // ground, like everything else that claims to touch it.
          const halfW = (trailWidth + (rng(s * 17 + w * 13) - 0.5) * 0.3) * 0.5;
          const halfL = (stepLen + 0.05) * 0.5;
          const tYaw = yaw + (rng(s * 19 + w * 23) - 0.5) * 0.06;
          const fwdX = Math.sin(tYaw), fwdZ = Math.cos(tYaw);
          const sideX = Math.cos(tYaw), sideZ = -Math.sin(tYaw);
          const localX = px - island.position.x;
          const localZ = pz - island.position.z;
          const cornerY = (fs: number, ss: number) => drawnGroundAt(
            ctx,
            localX + fwdX * halfL * fs + sideX * halfW * ss,
            localZ + fwdZ * halfL * fs + sideZ * halfW * ss,
          );
          // The CENTRE is drawn ground too — `py` is the analytic gate above
          // (which tiles exist at all), never the height one is laid at.
          const yCc = drawnGroundAt(ctx, localX, localZ);
          const yFf = cornerY(1, 0), yBb = cornerY(-1, 0);
          const yLl = cornerY(0, 1), yRr = cornerY(0, -1);
          const minCorner = Math.min(yCc, yFf, yBb, yLl, yRr);
          const tileThick = 0.26;
          // Slope basis from the corner samples: pitch along the path, roll across it.
          const pitch = Math.atan2(yBb - yFf, halfL * 2);
          const roll = Math.atan2(yLl - yRr, halfW * 2);
          trObj.position.set(localX, minCorner + 0.02, localZ);
          trObj.rotation.set(0, tYaw, 0);
          trObj.rotateX(pitch);
          trObj.rotateZ(roll);
          trObj.scale.set(halfW * 2, tileThick, halfL * 2);
          trObj.updateMatrix();
          tileXf.push(trObj.matrix.clone());
          // Occasional border stones
          if (!lowDetail && rng(s * 29 + w * 31) > 0.78) {
            const side = rng(s * 33 + w * 41) > 0.5 ? 1 : -1;
            const stx = px + Math.cos(yaw) * side * (trailWidth * 0.55 + 0.2);
            const stz = pz - Math.sin(yaw) * side * (trailWidth * 0.55 + 0.2);
            // Border stones lie ON the path, so they follow the drawn ground —
            // pinned to the analytic field they perched above the trail they
            // were supposed to be edging.
            const stLocalX = stx - island.position.x;
            const stLocalZ = stz - island.position.z;
            trP.set(stLocalX, drawnGroundAt(ctx, stLocalX, stLocalZ) + 0.02, stLocalZ);
            trE.set(rng(s * 51) * Math.PI, rng(s * 57) * Math.PI, rng(s * 61) * Math.PI);
            trQ.setFromEuler(trE);
            trS.setScalar(0.18 + rng(s * 47 + w * 53) * 0.18);
            kerbXf.push(trM.clone().compose(trP, trQ, trS));
          }
        }
      }
      if (tileXf.length) {
        const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), trailMat, tileXf.length);
        // `decor-` prefix on purpose: that is the live floater audit's CLAIMED
        // set. A paving stone is the single most literal thing in the world
        // that says "I am lying on the ground", and under the old bare name it
        // was filed as unclaimed scenery whose base may legitimately be in the
        // air — so the pavers were exempt from the one audit that could see
        // them float. They are held to the contract now.
        tiles.name = 'decor-trail-tile';
        tileXf.forEach((m, k) => tiles.setMatrixAt(k, m));
        tiles.instanceMatrix.needsUpdate = true;
        tiles.receiveShadow = true;
        group.add(tiles);
      }
      if (kerbXf.length) {
        const kerbs = new THREE.InstancedMesh(boulderGeo, stoneMat, kerbXf.length);
        kerbs.name = 'decor-trail-kerb';
        kerbXf.forEach((m, k) => kerbs.setMatrixAt(k, m));
        kerbs.instanceMatrix.needsUpdate = true;
        kerbs.castShadow = true;
        group.add(kerbs);
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
}

/** Bridges — rope-and-plank, rendered from the SERVER's replicated registry:
 *  endpoints are true terrain local-maxima found at generation, and the deck
 *  players walk on is the shared getBridgeDeckY math, so the bridge is genuinely
 *  solid and both ends sit flush on their peaks (the old client-only version
 *  guessed hill centers and connected to nothing). */
export function buildBridges(ctx: IslandBuildCtx) {
  const { island, group, rng, boulderGeo, boulderMat } = ctx;
  for (const islandBridge of island.bridges ?? []) {
    const a = { lx: islandBridge.ax - island.position.x, lz: islandBridge.az - island.position.z, y: islandBridge.ay };
    const b = { lx: islandBridge.bx - island.position.x, lz: islandBridge.bz - island.position.z, y: islandBridge.by };
    const dx = b.lx - a.lx;
    const dz = b.lz - a.lz;
    const span = Math.hypot(dx, dz);
    {
      const bridge = new THREE.Group();
      // A rope bridge between two fangs IS suspended over a chasm: its deck is
      // 15m of open air above the saddle, by design, and the grounding audit
      // reports it as unclaimed scenery on purpose. Named so the report says
      // "bridge-span" instead of "Group" and nobody has to identify it twice.
      bridge.name = 'bridge-span';
      const midX = (a.lx + b.lx) * 0.5;
      const midZ = (a.lz + b.lz) * 0.5;
      const yaw = Math.atan2(dx, dz);
      // Anchor bridge at midpoint, midpoint y = average of the two peaks (so each end rests at its peak)
      const midY = (a.y + b.y) * 0.5;
      bridge.position.set(midX, midY, midZ);
      bridge.rotation.y = yaw;
      // Height is applied per board from the shared span, not by tilting the
      // group: Euler tilt after yaw displaced both anchors in XZ and left the
      // visible planks below the surface physics actually walks.
      const deckAt = (t: number) => getBridgeSpanY(islandBridge, t) - midY;

      const plankMat2 = new THREE.MeshStandardMaterial({ color: 0x6b4623, roughness: 0.95 });
      const ropeMat2 = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
      const postMat2 = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1 });

      // Paired posts leave the route between them clear. The old single post
      // was planted directly in the middle of each landing.
      for (const end of [-1, 1] as const) {
        const endY = deckAt((end + 1) * 0.5);
        for (const side of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.65, 8), postMat2);
          post.position.set(side * (islandBridge.width * 0.5 + 0.13), endY + 0.65, end * span * 0.5);
          post.castShadow = true;
          bridge.add(post);
          for (let wrap = 0; wrap < 3; wrap++) {
            const knot = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.032, 4, 10), ropeMat2);
            knot.rotation.x = Math.PI * 0.5;
            knot.position.set(post.position.x, endY + 1.0 + wrap * 0.07, post.position.z);
            bridge.add(knot);
          }
        }
        // Anchoring cairn (so the post visually grounds into the rock)
        for (let s = 0; s < 4; s++) {
          const stone = new THREE.Mesh(boulderGeo, boulderMat);
          const ang = (s / 4) * Math.PI * 2;
          stone.position.set((s < 2 ? -1 : 1) * (islandBridge.width * 0.5 + 0.25), endY - 0.04,
            end * span * 0.5 + Math.sin(ang) * 0.45);
          stone.scale.setScalar(0.22 + rng(s * 851 + (end > 0 ? 1 : 2)) * 0.18);
          stone.rotation.set(rng(s * 853) * Math.PI, rng(s * 857) * Math.PI, rng(s * 859) * Math.PI);
          bridge.add(stone);
        }
      }

      // Sagging plank deck — sag is measured from the y=0 reference plane (bridge midline)
      const plankCount = Math.max(8, Math.ceil(span / 0.48));
      for (let i = 0; i < plankCount; i++) {
        const t = (i + 0.5) / plankCount;
        const z = (t - 0.5) * span;
        const plank = new THREE.Mesh(new THREE.BoxGeometry(islandBridge.width, 0.10, span / plankCount - 0.025), plankMat2);
        plank.position.set(0, deckAt(t) - 0.05, z);
        plank.castShadow = true;
        plank.receiveShadow = true;
        bridge.add(plank);
      }

      // Rope has a real round silhouette at walking distance. Tubes and
      // lashings share one material and are merged by the static batcher.
      const ropeSegments = Math.max(24, Math.ceil(span / 1.5));
      for (const side of [-1, 1] as const) {
        for (const height of [0, 1.05]) {
          const points: THREE.Vector3[] = [];
          for (let i = 0; i <= ropeSegments; i++) {
            const t = i / ropeSegments;
            points.push(new THREE.Vector3(side * islandBridge.width * 0.5,
              deckAt(t) + height, (t - 0.5) * span));
          }
          const curve = new THREE.CatmullRomCurve3(points);
          bridge.add(new THREE.Mesh(new THREE.TubeGeometry(curve, ropeSegments, height > 0 ? 0.038 : 0.05, 5, false), ropeMat2));
        }

        // Vertical lashings
        const verticalCount = Math.max(6, Math.floor(span / 1.2));
        for (let v = 0; v < verticalCount; v++) {
          const tv = (v + 0.5) / verticalCount;
          const zv = (tv - 0.5) * span;
          const lash = new THREE.Mesh(
            new THREE.CylinderGeometry(0.023, 0.023, 1.05, 5),
            ropeMat2,
          );
          lash.position.set(side * islandBridge.width * 0.5, deckAt(tv) + 0.525, zv);
          bridge.add(lash);
        }
      }

      group.add(bridge);
    }
  }
}

/** A toppled shrine on the high shoulder — three pillars, a lintel and a bowl. */
export function buildRuin(ctx: IslandBuildCtx) {
  const { island, group, r, rng, lowDetail, surfacePoint, isSolidDecorPoint, islandSeed, SURFACE_ABOVE_WATER, shrineMat } = ctx;
  if (!lowDetail && r > 48) {
    const ruin = new THREE.Group();
    ruin.name = 'decor-ruin';
    const ruinAngle = island.profile.primaryHillAngle + rng(islandSeed * 17) * 0.8;
    const ruinPos = surfacePoint(0.18 + rng(islandSeed * 23) * 0.18, ruinAngle, 0.02);
    // Shrine stones stand on the shoulder the player walks, not on the field
    // the shoulder was sampled from — the pillars stood 4-5m proud of it.
    snapToDrawnGround(getMeshGround(island), ruinPos, -0.14);
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
}
