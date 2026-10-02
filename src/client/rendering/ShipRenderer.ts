import { IK_GRIPS_KEY } from './character/ikSolvers.js';
import * as THREE from 'three';
import { braceCatch } from '../../shared/sailing.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { IslandDock, Player, Ship, ShipHole, ShipUpgradeType, Vec2 } from '../../shared/types/index.js';
import { FLOODING, SHIP, SHIP_STATS } from '../../shared/constants/index.js';
import {
  helmWheelRotZ, apparentWindLocal, flagPivotYaw, flagSlack, FLAG_MAX_DROOP, type ApparentWind,
} from './signConventions.js';
import { sampleWind, angleWrap, getSailRopeStationLocals, getBraceStationLocals, getShipBoardingLadderLocals, getMainMastLocalZ, getShipCompanionwayConfig, getShipQuarterdeckConfig, gerstnerHeight, getStormWaveIntensity, WAVE_PARAMS } from '../../shared/utils/index.js';
import { cargoTier } from '../../shared/cargo.js';
import { getAmmoCrateLocal, getCannonDeckLocalPosition, getShipGangwayPlan } from '../../shared/interactions.js';
// The hull loft lives in shared/ (ships-24 phase 1): the server stands crew on
// the same shape this renderer draws. scripts/test-hull-loft.mjs pins it.
import { HELM_COURSE_FADE, getHullProfile, getMastHeight, getShipRigPlan, hullSurfacePointAt, sailHoistFor, stationSurfaceAt } from '../../shared/hull.js';
import type { RigSailKind } from '../../shared/hull.js';
import type { HullProfile } from '../../shared/hull.js';
import type { RenderQuality } from './Renderer.js';
import { registerBudgetLight } from './LightBudget.js';
import { firstDrawFrameUntouched, firstDrawRemaining, showWhenAffordable, spendFirstDraw } from './FirstDrawBudget.js';
import { farSwapDistance, FAR_SWAP_HYSTERESIS } from '../world/island/InstanceLod.js';

/** Storm sea-state source accepted by update(): either a precomputed 0..1
 *  intensity, or the replicated storm ring so the renderer can evaluate the
 *  shared getStormWaveIntensity() per ship position. */
type ShipStormSource = number | { center: Vec2; safeRadius: number; phase: number } | null | undefined;

/** The hull AS DRAWN: mesh.root's world placement and its full attitude. Crew,
 *  camera and every welded point read this, never the snapshot transform. */
export type RenderedHullPose = { x: number; y: number; z: number; yaw: number; pitch: number; roll: number };

const UPGRADE_PENNANT_COLORS: Record<ShipUpgradeType, number> = {
  hull_reinforcement: 0x67b9ff,
  charged_cannons: 0xff8459,
  swift_sails: 0xf6d360,
  lightning_rod: 0xbfe4ff,
};


import { finishCanvasTexture, foamTexture, sailTexture, sprayTexture, supplyLidTexture, woodCanvas, woodTexture } from './ship/textures.js';
import type { SupplyKind } from './ship/textures.js';
import { applyPlankDetail, makePlankUniforms, addStrakeSpace, applyTimberEnvLift, type PlankUniforms } from './ship/plankDetail.js';
import { releaseShipGeometry } from './ship/geometry.js';
import { selectShipLod, shipLodKey, SHIP_LOD_BANDS, SHIP_LOD_HYSTERESIS, type ShipLodLevel } from './ship/lod.js';
import { buildRudder, buildSternCastle } from './ship/stern.js';
import { buildRig } from './ship/sails.js';
import { shipMotionOf, wheelFollowAlpha } from './ship/shipMotion.js';
import { DECK_KIT_SMALL, deckKitSockets, kitDrawCount, type DeckKitPart, mountShipKit, shipKitSockets, SHIP_KIT_FILES, SHIP_KIT_LOD_FILES, type KitSocket, type ShipKitFile, type ShipKitLodFile, type ShipKitSource } from './ship/kit.js';
import { SAIL_BELLY, SAIL_CLOTH_GRID, makeLodSailCard, sailFillTarget, sailLuff01, sailWind01, setSailClothUniforms, stepSailFill, type SailClothUniforms } from './ship/sailCloth.js';
import { applyRiggingLod, updateRigging, type Rigging, type RiggingSet } from './ship/rigging.js';
import { buildWakeSurface, writeWakeSurface, setArmsVisible, makeWakeFrame, ARM_FACTOR_FLOOR, buildWaterlineCollar, seatWaterlineCollar, type WakeSurface, type WakeFrame } from './ship/wake.js';
import { makeLoftedSlabGeometry, makeSheerRunGeometry, sheerHalfWidthAt, sheerZRange, makeHullStrakeGeometry, makeSplineHullGeometry, makeStairRampGeometry, makeWaterlineFoamTexture, mergeStaticMeshes, bakeVertexColorMerge, NO_MERGE_EXCLUDE } from './ship/geometry.js';
import { applyFlagWave, FLAG_DROP, FLAG_FLY, flagPhaseFromId, flagTexture, makeBarrel, makeCylinderBetween, makeHatchGrating, makeLanternFixture, makeRopeCoil } from './ship/dressing.js';
import type { FlagUniforms, ShipFlag } from './ship/dressing.js';
import {
  BILGE_BOARD_LEN_F, bilgeBoardInboardFaceAt, holdCeilingHalfAt, holdLockerTopY, HOLD_FLOOR_Y, HOLD_HALF_LENGTH_F, holdHalfWidthAt, makeHoldCargoStacks, makeShipInterior,
} from './ship/interior.js';
import { BREACH_GLSL, breachBasis, breachDiscardGlsl, breachExtent, breachSeed, buildBreachEdgeGeometry, buildBreachPatchGeometry, strakeTangentAt } from './ship/breach.js';
import { holeVisualRadius } from '../../shared/flooding/floodModel.js';
import { createHoldWater, disposeHoldWater, updateHoldWater, type HoldWaterHandle } from './ship/holdWater.js';
// ─────────────────────────────────────────────────────────────────────────────
// Lofted hull construction
//
// The hull is lofted from 9 cross-section stations, each with 7 vertical slots
// per side: sheer (deck edge) → tumblehome → wale (max beam) → topside →
// waterline → rounded bilge → keel. The SHEER half-widths are NOT the walkable
// deck line: pirates are clamped to the BULWARK INNER FACE (shared
// getShipDeckWalkHalfWidth, ~0.42·W amidships), which is deliberately inboard
// of the loft sheer (~0.56·W) so nobody stands out on the covering board. The
// standing contract is one-directional: the loft sheer must stay OUTBOARD of
// the walk taper at every station, so the walk clamp never puts a pirate past
// a rendered line. (Verified station by station in src/shared/hull.ts, and
// re-checked at 400 z samples by scripts/test-hull-loft.mjs.)
// Everything below the sheer is free visual shape: gentle tumblehome above the
// wale, a flared V bow with a forward-raked stem, a mildly raked underwater
// stern, and real DRAFT — the keel sits ~0.8-1.2m below the waterline so hulls
// ride IN the water instead of on top of it.
// ─────────────────────────────────────────────────────────────────────────────

/** Decal forward axis: hole groups are built facing +Z and rotated onto the
 *  hull's outward surface normal. */
const HULL_Z_AXIS = new THREE.Vector3(0, 0, 1);
/** b2.3c: a board-seated breach backdrop sits this far along the tube from
 *  the board face (just behind its 0.16 m back face) with this radius. */
const BREACH_BACKDROP_BEHIND_BOARD = 0.2;
const BREACH_BACKDROP_BOARD_R = 0.4;

/** Three quarter-turns of the helm from hard a-port to hard a-starboard. */
/**
 * ONE threshold decides whether the canvas is set or rolled on the yard.
 * Deployed used `> 0.05` and the furled bundle `<= 0.12`, so for ~7% of the
 * hoist range both were drawn, one inside the other (ships-15).
 */
const SAIL_FURL_THRESHOLD = 0.08;

/**
 * SEE-THROUGH BREACHES, ON EVERY SURFACE THAT HUGS THE SHELL.
 *
 * The hull shader discards planking inside each open hole, which is what makes
 * a breach a real opening instead of a painted disc. The proud strakes (sheer
 * strake, main wale, boot-top) and the hull-reinforcement armour are SEPARATE
 * merged meshes with their own materials, so they were never discarded: the
 * boot-top (y 0.03..0.13) ran straight through the bottom of every ram, rock,
 * grounding, keg, storm and scuttle hole in HOLE_BAND_Y 0.10..0.45, and the
 * armour belts crossed the rest. A hole with a timber bar across it reads as a
 * rendering error, not as torn planking (ships-07).
 *
 * The discard is in HULL-LOCAL space, so a mesh using this material must sit at
 * identity in the ship group (the strakes and belts are lofted in hull-local
 * space; the ribs and plates bake their offset into the geometry). Instanced
 * meshes carry their offset in `instanceMatrix`, which is applied here.
 */
/** Per-slot breach uniforms: `value` = (hull-local point, size radius),
 *  `shape` = (strake tangent, seed) for the jagged outline (b2.3d). */
type HullHoleUniform = { value: THREE.Vector4[]; shape: { value: THREE.Vector4[] } };

function applyHullHoleDiscard(
  material: THREE.Material,
  holeUniform: HullHoleUniform,
  slots: number,
  /** holes-06: when given, each slot cuts a CAPSULE from the shell point
   *  (uHoles.xyz) to an inboard seat (uHoleEnds.xyz) at the same radius, a
   *  tube through the hull AND the hold lining / sole / bilge boards. A slot
   *  whose end equals its point degenerates to the shell's own sphere. */
  ends?: { value: THREE.Vector4[] },
): void {
  // b2.3d: the cut is the seeded torn outline of ship/breach.ts, stretched
  // along the strake, evaluated per fragment (no texture, no per-hole program).
  const test = breachDiscardGlsl(slots, !!ends);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHoles = holeUniform;
    shader.uniforms.uHoleShape = holeUniform.shape;
    if (ends) shader.uniforms.uHoleEnds = ends;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHullPos;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vHullPos = (instanceMatrix * vec4(position, 1.0)).xyz;
#else
  vHullPos = position;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHullPos;\nuniform vec4 uHoles[${slots}];\nuniform vec4 uHoleShape[${slots}];${ends ? `\nuniform vec4 uHoleEnds[${slots}];` : ''}\n${BREACH_GLSL}`)
      .replace('#include <map_fragment>', `${test}\n#include <map_fragment>`);
  };
  // A material whose program source changed must be recompiled, and two
  // materials that differ only by this patch must not share a program.
  const key = `hull-hole-discard-${slots}${ends ? '|capsule' : ''}`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}


interface CannonMeshGroup {
  root: THREE.Group;
  yawPivot: THREE.Group;
  pitchPivot: THREE.Group;
}

// ── SHIP HARDWARE GLBs (b3.4e, assets-01) ────────────────────────────────────
// cannon / wheel / capstan / ship_lantern (+ their _far siblings) are Blender
// builds (scripts/blender/build_ship_hardware.py) whose pivots test-hero-assets
// pins: the cannon's `barrel` node sits ON the trunnions and points +Z, the
// `wheel_body` disc lies in XY so rotation.z spins it, the capstan's `drum`
// stands on `capstan_body`, the lantern hangs from its hook at y = 0. They are
// mounted over the procedural hardware the moment the library has all four;
// before that (the queue window) the procedural pieces are the fallback.
export const SHIP_HARDWARE = ['cannon', 'wheel', 'capstan', 'ship_lantern'] as const;
export type ShipHardwareName = (typeof SHIP_HARDWARE)[number];
/** What ShipRenderer needs from the asset library (AssetLibrary satisfies it;
 *  the node gate passes a stub). */
export interface ShipHardwareSource {
  has(name: ShipHardwareName): boolean;
  clone(name: ShipHardwareName): THREE.Group | null;
  cloneFar(name: ShipHardwareName): THREE.Group | null;
}
/** Uniform scale of the cannon GLB: trunnion 0.54 m over the carriage base
 *  (the procedural pivot height) and a 1.5 m barrel, as the gun it replaces. */
export const HW_CANNON_SCALE = 0.9;
/** Capstan GLB scale: bar ends at ~0.8 m radius, inside the 1.25 m clearance
 *  ring the deck barrels already keep (see the supply-barrel keep-outs). */
export const HW_CAPSTAN_SCALE = 0.8;
/** The wheel GLB's outer (handle-tip) radius in its own units. The ship's rim
 *  radius rimR is per hull class; handles jut 0.16 m past it. */
const HW_WHEEL_TIP_R = 0.84;
const HW_SHARED = 'hwShared';
interface HardwarePart { near: THREE.Object3D; far: THREE.Object3D | null }
export interface ShipHardwareMount { parts: HardwarePart[]; far: boolean; lanterns: number }

/** Handle / bar tips of a spoked part, clustered by angle, in `root` space:
 *  the IK grip anchors come out of the GLB instead of a hand-typed ring. */
function radialTips(root: THREE.Object3D, plane: 'xy' | 'xz'): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const pts: THREE.Vector3[] = [];
  root.traverse((o) => {
    const pos = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry?.getAttribute?.('position') : undefined;
    if (!pos || !(pos as THREE.BufferAttribute).array?.length) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m));
  });
  const rad = (p: THREE.Vector3) => (plane === 'xy' ? Math.hypot(p.x, p.y) : Math.hypot(p.x, p.z));
  const ang = (p: THREE.Vector3) => (plane === 'xy' ? Math.atan2(p.y, p.x) : Math.atan2(p.z, p.x));
  let maxR = 0;
  for (const p of pts) maxR = Math.max(maxR, rad(p));
  const tips = pts.filter((p) => rad(p) > maxR * 0.93).sort((a, b) => ang(a) - ang(b));
  if (tips.length === 0) return [];
  const clusters: THREE.Vector3[][] = [[tips[0]]];
  for (let i = 1; i < tips.length; i++) {
    if (ang(tips[i]) - ang(tips[i - 1]) > 0.15) clusters.push([]);
    clusters[clusters.length - 1].push(tips[i]);
  }
  // The cluster straddling ±π is one handle cut in two.
  if (clusters.length > 1 && ang(tips[0]) + 2 * Math.PI - ang(tips[tips.length - 1]) <= 0.15) {
    clusters[0].push(...clusters.pop()!);
  }
  return clusters.map((c) => c.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(c.length));
}

interface WakeSpray {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

/** Scene-level animated wake: the ribbon lives in WORLD space (never parented
 *  to the ship) so hull pitch/roll/sinking can't tilt it out of the water. */
interface ShipWake {
  group: THREE.Group;
  ribbon: THREE.Mesh;
  /** Stern ribbon + (off the low tier) the Kelvin arms and bow sheets, in ONE
   *  geometry and one draw — see rendering/ship/wake.ts. */
  surface: WakeSurface;
  material: THREE.MeshBasicMaterial;
  spray: WakeSpray[];
  sprayCursor: number;
  sprayTimer: number;
  scroll: number;
}
/**
 * How far outside a dock's own footprint a hull can still be and produce a
 * boarding plank: half the longest hull (22m), plus her beam, plus the planner's
 * 3.6m maximum span, rounded well up. Used only to reject pairs that CANNOT
 * berth before the shared planner is asked — see syncGangways.
 */
const GANGWAY_REJECT_MARGIN = 40;

/** One rendered breach: the torn-planking decal group on the hull surface, its
 *  pulsing "plank me" halo, the gush anchor Game.ts hangs water jets on, the
 *  optional deck-side inner decal, and the crossed planks once it is patched. */
interface HoleVis {
  group: THREE.Group;
  /** Torn rim + splinters, oriented to the shell normal. Re-aimed on a move. */
  decal: THREE.Group;
  marker: THREE.Mesh;
  gush: THREE.Object3D;
  patch: THREE.Group | null;
  /** Hull-local surface point the shader discards around. */
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** The SERVER hole coords this seating was computed from. A hole is keyed by
   *  id, and two server paths move a live id: fire burn-down walks it down to
   *  the waterline, and placeHole recycles a patched slot at the 8-cap. Without
   *  this the decal, the see-through disc, the gush and the [X] marker stayed at
   *  the old spot while the bilge filled from somewhere else (ships-26). */
  src: THREE.Vector3;
  patched: boolean;
  /** holes-06: hull-local inboard seat of the breach (the lining's inner face
   *  for a hole above the sole, the sole edge above it for one below), its
   *  facing (into the hold), and whether the hold is there at all (a hole
   *  forward or aft of the hold has no lining to cut: inner == point). */
  inner: THREE.Vector3;
  innerNormal: THREE.Vector3;
  hasSeat: boolean;
  belowSole: boolean;
  /** Torn inboard ring + welling water, seated at `inner` (child of root). */
  inboard: THREE.Group;
  ring: THREE.Group;
  welling: THREE.Mesh;
  /** Dark-water / daylight disc just outboard of the opening, facing INTO the
   *  hull (FrontSide, so it is culled from outside and only the hold sees it). */
  backdrop: THREE.Mesh;
  /** b2.3d: breach size (1..3), its radius, the id seed of the torn outline,
   *  the strake tangent the shader reads (sign chosen so the frame's +y is
   *  up), the per-hole torn-edge geometries and the halo scale. */
  size: number;
  R: number;
  seed: number;
  tangent: THREE.Vector3;
  edgeGeo: THREE.BufferGeometry;
  ringGeo: THREE.BufferGeometry;
  ringFlipped: boolean;
  markerScale: number;
}

/** Camera range inside which a breach draws its inboard pieces (ring, welling,
 *  backdrop): only a pirate aboard or alongside can see into a hold. */
const BREACH_INBOARD_DIST_SQ = 45 * 45;

/** Camera range inside which a SEALED hull draws its hold (b2-device-04). The
 *  hold interior is ~14k verts on a galleon (floor, bilge boards, inner wall,
 *  hammocks, cargo) behind closed planking: beyond this it only shows down the
 *  companionway or through an open breach, so a far hull with no open breach
 *  skips it (and its shadow-pass copy). Own ship always draws it. */
const HOLD_INTERIOR_DIST_SQ = 60 * 60;

/** LOD1 drops parts smaller than this (world bounding radius, m): under two
 *  pixels at 30 m, and the bulk of the detail hull's triangle count. */
const LOD1_MIN_PART_RADIUS = 0.3;
/** Vertex tone of a textured material in the LOD1 bake (its map is dropped). */
const LOD1_TEXTURED_TONE: Record<string, number> = {
  'ship-dark-timber': 0x3a2412,
  'ship-deck-planking': 0x8a6a48,
  'ship-hull-strake': 0x2c1b10,
  'ship-rope': 0xa48a5c,
  default: 0x5a3c24,
};

interface ShipMeshGroup {
  root: THREE.Group;
  detailRoot: THREE.Group;
  proxyRoot: THREE.Group;
  proxySails: THREE.Mesh[];
  /** b4.2d LOD1 (30-90 m): spline shell 36 x 12 + the detail parts baked into
   *  one vertex-coloured draw, one instanced sail draw, flag (<= 12 draws). */
  lod1Root: THREE.Group;
  lod1Sails: THREE.InstancedMesh;
  /** b4.2d LOD2 (90-250 m): spline shell 18 x 8, timber, one instanced sail draw, flag. */
  lod2Root: THREE.Group;
  lod2Sails: THREE.InstancedMesh;
  lod2SailAngle: number;
  lod2SailScale: number;
  /** Current ship LOD level (ship/lod.ts selectShipLod, 10% hysteresis). */
  lodLevel: ShipLodLevel;
  sails: THREE.Mesh[];
  furledSails: THREE.Mesh[];
  pennants: THREE.Mesh[];
  /** Masthead team flag — own pivot + vertex-wave uniforms (not merged). */
  flag: ShipFlag;
  upgradePennants: Record<ShipUpgradeType, THREE.Mesh>;
  upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]>;
  fireParticles: THREE.Points | null;
  /** Lofted section table — lets update() project a freshly-arrived breach
   *  onto the REAL planking surface instead of a box approximation. */
  hullProfile: HullProfile;
  /** Live breach decals keyed by ShipHole.id. Built on demand as holes arrive
   *  on the wire, disposed when the entity leaves the list. */
  holeVis: Map<number, HoleVis>;
  /** Yard+sail+furled-roll pivots, one per square-rigged mast (rotated to trim). */
  trimPivots: THREE.Group[];
  /** Instanced rope + ratline rigging; the yard-attached runs follow the trim. */
  rigging: Rigging | null;
  /** b4.2h: rope + ratline + far-card draws, in ship-rig-root (LOD0-LOD2 ropes, LOD3 cards). */
  rigSet: RiggingSet | null;
  cannonMeshes: CannonMeshGroup[];
  lanterns: THREE.PointLight[];
  wheel: THREE.Object3D;
  /** Rudder blade on its own stock: rotation.y is Ship.rudderAngle. */
  rudderPivot: THREE.Object3D;
  compassNeedle: THREE.Object3D;
  anchor: THREE.Group;
  anchorChain: THREE.Mesh;
  anchorCapstan: THREE.Group;
  /** b3.4e: the GLB hardware mounted on this hull, or null while the procedural
   *  fallback is still up (the library had not loaded the four files yet). */
  hardware: ShipHardwareMount | null;
  /** b4.3c: the Blender ship kit mounted on spline sockets, null until both kit files stream in. */
  kit: THREE.Group | null;
  kitSockets: KitSocket[];
  /** Helm rim radius for this hull class (the wheel GLB is fitted to it). */
  wheelRimR: number;
  /** Shared warm-amber glass materials whose emissiveIntensity ramps with night. */
  lanternGlassMats: THREE.MeshStandardMaterial[];
  /** One warm PointLight per ship (budgeted: only the nearest few get lit at night). */
  nightLight: THREE.PointLight | null;
  /** The hold water (ship/holdWater.ts): world-level, clipped, sloshing. */
  holdWater: HoldWaterHandle | null;
  /** Cumulative cargo-stack variants, index 0 = tier 1 … index 3 = tier 4.
   *  Exactly one (or none) is visible; see ship.cargoGold. */
  holdCargoTiers: THREE.Object3D[];
  /** Meshes whose material only the hold uses (merged per material, so hiding
   *  them costs no draw call and hides nothing on deck), plus the cargo stack.
   *  Hidden on a sealed hull beyond HOLD_INTERIOR_DIST_SQ. */
  holdInterior: THREE.Object3D[];
  holdInteriorShown: boolean;
  wake: ShipWake;
  /** vec4 (xyz = hull-local hole center, w = radius) driving the hull's
   *  fragment-discard breaches, one slot per UNPATCHED hole; radius 0 =
   *  inactive. MAX_HOLES_PER_SHIP slots — the server can never exceed it. */
  hullHoleUniform: HullHoleUniform;
  /** Inboard end of each capsule slot (holes-06), read by the hold surfaces. */
  hullHoleEnds: { value: THREE.Vector4[] };
  /** Hold lining inner half-width at hull-local z, and the hold's half-length. */
  holdHalfAt: (z: number) => number;
  holdHalfLen: number;
  /** holes-06: the bilge board's inboard face at height y (null above/below it). */
  bilgeFaceAt: (side: -1 | 1, y: number) => { x: number; nx: number; ny: number } | null;
  /** b2.3e: inner planking half-width at (z, y); above lockerTop it is the hold's skin. */
  ceilingAt: (z: number, y: number) => number;
  lockerTop: number;
  /** Waterline contact collar (wet-edge foam hugging the hull's own waterline). */
  waterlineFoam: THREE.Mesh;
  /** Phase-A planking uniforms: the hull-local wet line, moved every frame. */
  plankUniforms: PlankUniforms;
  /**
   * THE ONE HULL IN THE REACH THAT IS YOURS.
   *
   * Ten crews sail ten hulls that differ only by team colour, and team colour
   * is a stranger's colour too — an auditor fought half a match off somebody
   * else's derelict cutter with her own ship 876 m away and nothing on screen
   * ever said so. This is a gold swallowtail flown at the TRUCK, above the
   * ensign, and it is hoisted on exactly one ship: yours. It matches the words
   * the tour and the chart already use ("the one ringed in gold").
   */
  ownPennant: THREE.Mesh;
}

/** One instanced LOD sail per SQUARE sail of the shared rig plan (b4.2f). */
interface LodSailSlot { kind: RigSailKind; z: number; headY: number; w: number; h: number }
function lodSailSlots(plan: ReturnType<typeof getShipRigPlan>): LodSailSlot[] {
  const slots: LodSailSlot[] = [];
  for (const mast of plan) {
    for (const s of mast.sails) {
      if (s.kind === 'spanker') continue;
      slots.push({ kind: s.kind, z: mast.z, headY: s.headY, w: (s.headW + s.footW) * 0.5, h: s.headY - s.footY });
    }
  }
  return slots;
}

export class ShipRenderer {
  private shipMeshes: Map<string, ShipMeshGroup> = new Map();
  private scene!: THREE.Scene;
  private quality: RenderQuality = 'balanced';
  /** b3.4e: where the hardware GLBs come from (the shared AssetLibrary in the
   *  browser, a stub in the node gate). Null = procedural hardware only. */
  private hardwareSource: ShipHardwareSource | null = null;
  /** Grip anchors per hardware file, in GLB units (computed once per file). */
  private readonly hardwareTips = new Map<string, THREE.Vector3[]>();
  /** Meshes per hardware file (near / far), counted once: the late mount's price. */
  private readonly hardwareMeshCount = new Map<string, number>();
  setHardwareSource(src: ShipHardwareSource | null): void { this.hardwareSource = src; }
  /** b4.3c: the ship kit's library (AssetLibrary in the browser); streamed on first need. */
  private kitSource: (ShipKitSource & { ensure?(name: ShipKitFile | ShipKitLodFile): Promise<void> }) | null = null;
  private kitRequested = false;
  private kitPrice: number | undefined;
  setKitSource(src: (ShipKitSource & { ensure?(name: ShipKitFile | ShipKitLodFile): Promise<void> }) | null): void { this.kitSource = src; }

  private kitReady(): boolean {
    const src = this.kitSource;
    if (!src) return false;
    const files = [...SHIP_KIT_FILES, ...SHIP_KIT_LOD_FILES];
    if (files.every((f) => src.has(f))) return true;
    if (!this.kitRequested && src.ensure) {
      this.kitRequested = true;
      for (const f of files) void src.ensure(f).catch(() => { /* hull stays bare of kit */ });
    }
    return false;
  }

  /** Mount the kit on one hull: the hull parts under the detail root (LOD0
   *  band), the rudder under its stock so it turns with Ship.rudderAngle. */
  private mountKit(mesh: ShipMeshGroup): void {
    const src = this.kitSource;
    if (!src) return;
    const glass = mesh.lanternGlassMats[0] ?? null;
    const hull = mesh.kitSockets.filter((s) => s.part !== 'rudder');
    const root = mountShipKit(hull, src, glass);
    if (!root) return;
    mesh.detailRoot.add(root);
    // The level roots get the kit's own LOD1/LOD2 geometry on the same
    // sockets, so the figurehead, galleries and gunports do not pop off at
    // 30 m (the rudder is under water past the detail band: LOD0 only).
    const lod1 = mountShipKit(hull, src, glass, 1);
    if (lod1) mesh.lod1Root.add(lod1);
    const lod2 = mountShipKit(hull.filter((s) => !DECK_KIT_SMALL.has(s.part)), src, glass, 2);
    if (lod2) { lod2.traverse((o) => { o.castShadow = false; }); mesh.lod2Root.add(lod2); }
    const rudder = mesh.kitSockets.find((s) => s.part === 'rudder');
    if (rudder) {
      const p = mesh.rudderPivot.position;
      const local: KitSocket = { ...rudder, pos: [rudder.pos[0] - p.x, rudder.pos[1] - p.y, rudder.pos[2] - p.z] };
      const blade = mountShipKit([local], src, glass);
      if (blade) {
        mesh.rudderPivot.add(blade);
        const old = mesh.rudderPivot.getObjectByName('rudder-blade');
        if (old) old.visible = false;
      }
    }
    mesh.kit = root;
    shipMotionOf(mesh).bindLids([root, lod1, lod2]); // b4.3d: gunport lids open on the guns
  }
  /** One reused frame record for every hull's wake — filled in place each
   *  update so driving twelve wakes allocates nothing. */
  private wakeFrame: WakeFrame = makeWakeFrame();
  private darkWoodTex!: THREE.CanvasTexture;
  private deckTex!: THREE.CanvasTexture;
  private sailTex!: THREE.CanvasTexture;
  private foamTex!: THREE.CanvasTexture;
  /** Waterline contact ramp (bright at the planking, clear at the fringe). */
  private waterlineFoamTex!: THREE.CanvasTexture;
  private sprayTex!: THREE.CanvasTexture;
  private readonly teamSailTex = new Map<number, THREE.CanvasTexture>();
  private readonly teamHullTex = new Map<number, THREE.CanvasTexture>();
  private readonly tempShipPos = new THREE.Vector3();
  /** Scratch for the per-ship apparent wind the flag and pennants fly on. */
  private readonly apparentWind: ApparentWind = { localYaw: 0, speed: 0 };
  private readonly tempHoleQuat = new THREE.Quaternion();
  private readonly tempCannonPos = new THREE.Vector3();
  /** Shared pulsing halo for hull-hole decals — depth-tested so it can never
   *  glow through the hull or a sniper scope (the retired-beacon lesson). */
  private readonly holeMarkerMat = new THREE.MeshBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  /** b2.3d: the torn edge is ONE vertex-coloured mesh per breach face (char
   *  lip, broken-plank wall, bent plank ends, splinters): one draw, one program. */
  private readonly holeRimMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  /** The pulsing halo ring, shared; the torn edge is per breach (b2.3d). */
  private holeDecalGeo: { marker: THREE.RingGeometry } | null = null;
  /**
   * Who is on which cannon this frame, as `shipId -> operator by cannon index`.
   *
   * It used to be one flat map keyed `${shipId}:${cannonIndex}`, which meant a
   * fresh string built for every crewed cannon when the map was filled AND
   * another for every cannon on every hull when it was read — ten hulls of eight
   * guns is eighty throwaway strings a frame to answer a question two integers
   * already contain. The inner arrays are pooled per ship id and only ever
   * cleared, never reallocated.
   */
  private readonly cannonOperators = new Map<string, Array<Player | undefined>>();
  /** Upgrade types on a hull this frame — one scratch Set, cleared per hull,
   *  instead of `new Set(ship.upgrades.map(...))` per hull per frame. */
  private readonly activeUpgrades = new Set<ShipUpgradeType>();
  /** The upgrade-pennant keys, resolved once. `Object.entries` on the pennant
   *  record allocated an array plus one two-element array per pennant, per hull,
   *  per frame, to walk a key list that is fixed at build time. */
  private upgradePennantTypes: ShipUpgradeType[] | null = null;
  /** …and the same for the upgrade-VISUALS record, walked per hull per frame. */
  private upgradeVisualTypes: ShipUpgradeType[] | null = null;
  private windOverride: { direction: number; strength: number } | null = null;
  private readonly waveMotion = { pitch: 0, roll: 0, surfaceY: 0 };
  /** 0 = day, 1 = night. Drives lantern glass emissive + per-ship PointLights. */
  private nightFactor = 0;
  /** Probe-only pin of every hull's hold water and attitude (hold-water-probe). */
  private holdWaterDebug: { fill: number; roll?: number; pitch?: number } | null = null;
  private readonly holdWaterDebugHeld = new Map<string, { pos: THREE.Vector3; yaw: number }>();
  /** Frame counter for throttling per-vertex work (sail-cloth normals). */
  private frameIndex = 0;
  /** Island docks, for boarding gangways. Game feeds these from the snapshot;
   *  empty = no berths known, so no planks are drawn. */
  private docks: IslandDock[] = [];
  /** Pooled boarding planks (scene-level: a plank bridges ship and dock, so it
   *  must not inherit the hull's pitch/roll). */
  private gangwayPlanks: THREE.Group[] = [];
  private gangwayMat!: THREE.MeshStandardMaterial;
  /** Shared across every planked breach on every hull (see addPlankPatch). */
  private plankPatchMat: THREE.MeshStandardMaterial | null = null;
  /** b1-ask-05: constant materials never mutated after build, one per renderer
   *  instead of one per ship (each distinct material holds its own uniform clone). */
  private readonly sharedMats = new Map<string, THREE.MeshStandardMaterial>();
  private sharedMat(key: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    let m = this.sharedMats.get(key);
    if (!m) this.sharedMats.set(key, (m = new THREE.MeshStandardMaterial(params)));
    return m;
  }

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    this.scene = scene;
    this.quality = quality;
    // Browser only (`location`): node gates import this file without a library.
    if (!this.hardwareSource && typeof location !== 'undefined') {
      void import('../assets/AssetLibrary.js')
        .then((m) => { this.hardwareSource ??= m.assets; this.kitSource ??= m.assets; })
        .catch(() => { /* procedural hardware stays */ });
    }
    this.darkWoodTex = woodTexture(256, 128, 'dark');
    this.deckTex     = woodTexture(256, 256, 'deck');
    this.sailTex     = sailTexture();
    this.foamTex     = foamTexture();
    this.waterlineFoamTex = makeWaterlineFoamTexture();
    this.sprayTex    = sprayTexture();
  }

  /** Island docks (from the replicated island list) — the berths a ship can
   *  drop a boarding plank to. Call once per snapshot; cheap (a reference). */
  setDocks(docks: IslandDock[]) {
    this.docks = docks;
  }

  /** Optional wind override for sail cloth + pennants. Defaults to sampleWind(t). */
  setWind(dirRad: number, strength: number) {
    this.windOverride = { direction: dirRad, strength: THREE.MathUtils.clamp(strength, 0, 1.5) };
  }

  /** Day↔night lantern control. 0 = day (glass barely emissive, ship lights off),
   *  1 = night (warm glass glow + one warm PointLight on the nearest few ships).
   *  Game.ts should call this every frame with the sky's night factor (0–1). */
  /** Debug hook (hold-water-probe): pin the drawn fill (and roll/pitch) of every hull; null releases. */
  setHoldWaterDebug(pin: { fill: number; roll?: number; pitch?: number } | null) {
    this.holdWaterDebug = pin && Number.isFinite(pin.fill) ? { ...pin, fill: Math.min(1, Math.max(0, pin.fill)) } : null;
    if (!this.holdWaterDebug) this.holdWaterDebugHeld.clear();
  }

  /** The hold-water state of a hull (probes, b2.3f underwater tint). */
  getHoldWater(shipId: string): HoldWaterHandle | null {
    return this.shipMeshes.get(shipId)?.holdWater ?? null;
  }

  setNightFactor(nf: number) {
    this.nightFactor = THREE.MathUtils.clamp(nf, 0, 1);
  }

  clear() {
    for (const mesh of this.shipMeshes.values()) {
      this.scene.remove(mesh.root);
      this.scene.remove(mesh.wake.group);
      if (mesh.holdWater) disposeHoldWater(mesh.holdWater);
      // Dispose per-ship GPU buffers (lofted hulls, rigging, decals are unique
      // per ship) or every match restart leaks them all. Materials are mostly
      // shared palette/canvas singletons — leave those alive.
      // releaseShipGeometry, not dispose: the merged static hull is SHARED
      // across every ship of this class (perf-15). Disposing it here would take
      // the planking off the other nine hulls still afloat. It is refcounted and
      // disposed by the last holder.
      for (const root of [mesh.root, mesh.wake.group]) {
        root.traverse((obj) => {
          if (obj.userData[HW_SHARED]) return; // library-owned hardware GLB geometry
          releaseShipGeometry((obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined);
        });
      }
    }
    this.shipMeshes.clear();
  }

  private getTeamSailTexture(teamColor: number): THREE.CanvasTexture {
    let tex = this.teamSailTex.get(teamColor);
    if (!tex) {
      tex = sailTexture(teamColor);
      this.teamSailTex.set(teamColor, tex);
    }
    return tex;
  }

  /** Natural wood hull with a MUTED painted wale stripe in the team hue plus a
   *  weathered boot-top and dark antifouling below the waterline. The loft UV
   *  maps the whole shell (keel→sheer) to v 0..1 with the waterline at v≈0.25,
   *  so the painted bands hug the sheer/waterline curves with no extra meshes
   *  and zero emissive — team identity at distance comes from flag + sail band. */
  private getTeamHullTexture(teamColor: number): THREE.CanvasTexture {
    let tex = this.teamHullTex.get(teamColor);
    if (!tex) {
      const canvas = woodCanvas(256, 128, 'hull');
      const ctx = canvas.getContext('2d')!;
      // Desaturate the (often neon) team palette toward painted wood: worn
      // ship paint, not plastic. ~55% team hue, 45% dark oiled timber.
      const tr = (teamColor >> 16) & 0xff, tg = (teamColor >> 8) & 0xff, tb = teamColor & 0xff;
      const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
      const pr = mix(tr, 0x3a, 0.62), pg = mix(tg, 0x2a, 0.62), pb = mix(tb, 0x18, 0.62);
      // CanvasTexture flips Y: high v (sheer) lives near the TOP of the canvas.
      // Painted wale band (v≈0.81-0.89 → canvas y 14-25), matte and worn.
      ctx.globalAlpha = 0.68;
      ctx.fillStyle = `rgb(${pr}, ${pg}, ${pb})`;
      ctx.fillRect(0, 14, 256, 11);
      // Wear: streaks of the wood ghosting through the paint
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#3a2a18';
      for (let i = 0; i < 26; i++) {
        const x = Math.random() * 256;
        ctx.fillRect(x, 14 + Math.random() * 8, 1.5 + Math.random() * 6, 2 + Math.random() * 4);
      }
      // Dark caulked edging above/below the painted band
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#1c1008';
      ctx.fillRect(0, 13, 256, 2);
      ctx.fillRect(0, 25, 256, 2);
      // Below the waterline (v<~0.24 → canvas y>98): dark weathered antifouling pitch
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#221a12';
      ctx.fillRect(0, 98, 256, 30);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#141009';
      for (let i = 0; i < 22; i++) {
        const x = Math.random() * 256;
        ctx.fillRect(x, 98 + Math.random() * 26, 2 + Math.random() * 9, 1.5 + Math.random() * 3);
      }
      // Pale boot-top stripe straddling the waterline (v≈0.235-0.272 → y 93-98)
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = '#b9ab89';
      ctx.fillRect(0, 93, 256, 5);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#6d6350';
      for (let i = 0; i < 18; i++) {
        ctx.fillRect(Math.random() * 256, 93 + Math.random() * 4, 3 + Math.random() * 8, 1.2);
      }
      ctx.globalAlpha = 1;
      tex = finishCanvasTexture(canvas);
      this.teamHullTex.set(teamColor, tex);
    }
    return tex;
  }

  /** Far (> 250 m, level 3): spline shell 9 x 5, deck, castle, bowsprit, masts
   *  and sail cards in ONE vertex-coloured draw, plus the flag (team identity
   *  at range). Static: sails do not trim at this range. */
  private buildShipFar(ship: Ship, stats: typeof SHIP_STATS[keyof typeof SHIP_STATS]) {
    const W = stats.width, L = stats.length, H = stats.height;
    const group = new THREE.Group();
    group.name = 'ship-proxy';
    const profile = getHullProfile(ship.type);
    const team = new THREE.Color(ship.teamColor);
    const hullC = new THREE.Color(0x5a3a22), timberC = new THREE.Color(0x3a2412);
    const sailC = new THREE.Color(0xeadfbf), teamSailC = sailC.clone().lerp(team, 0.45);
    const parts: THREE.BufferGeometry[] = [];
    const m4 = new THREE.Matrix4();
    const add = (geo: THREE.BufferGeometry, color: THREE.Color, matrix?: THREE.Matrix4) => {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      geo.dispose();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      if (matrix) g.applyMatrix4(matrix);
      if (!g.attributes.normal) g.computeVertexNormals();
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g);
    };
    add(makeSplineHullGeometry(profile, 3), hullC);
    add(new THREE.BoxGeometry(W * 0.9, 0.12, L * 0.72), timberC, m4.makeTranslation(0, H + 0.04, 0));
    add(new THREE.BoxGeometry(W * 0.88, H * 0.28, L * 0.22), timberC, m4.makeTranslation(0, H + H * 0.14, -L * 0.37));
    add(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 5), timberC,
      new THREE.Matrix4().compose(new THREE.Vector3(0, H + 0.48, L * 0.61), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, -0.04)), new THREE.Vector3(1, 1, 1)));
    // b4.2f: the shared rig plan, one card per square sail.
    const rigPlan = getShipRigPlan(stats);
    const mastStartZ = rigPlan[0].z;
    for (let m = 0; m < rigPlan.length; m++) {
      const mast = rigPlan[m];
      add(new THREE.CylinderGeometry(0.07, 0.1, mast.height, 5), timberC, m4.makeTranslation(0, H + mast.height * 0.5, mast.z));
      for (const s of mast.sails) {
        if (s.kind === 'spanker') continue;
        add(new THREE.PlaneGeometry((s.headW + s.footW) * 0.5, s.headY - s.footY), m === 0 && s.kind === 'course' ? teamSailC : sailC,
          new THREE.Matrix4().compose(new THREE.Vector3(0, (s.headY + s.footY) * 0.5, mast.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.055, 0, 0, 'YXZ')), new THREE.Vector3(1, 1, 1)));
      }
    }
    const merged = mergeGeometries(parts, false)!;
    for (const g of parts) g.dispose();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02, side: THREE.DoubleSide });
    mat.name = 'ship-far';
    group.add(new THREE.Mesh(merged, mat));
    group.add(this.makeLodFlag(ship, rigPlan[0].truckY, mastStartZ));
    return group;
  }

  private makeLodFlag(ship: Ship, truckY: number, mastStartZ: number): THREE.Mesh {
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.62),
      new THREE.MeshStandardMaterial({
        color: ship.teamColor,
        emissive: ship.teamColor,
        emissiveIntensity: 0.25,
        side: THREE.DoubleSide,
        roughness: 0.85,
      }),
    );
    flag.position.set(0.38, truckY + 0.5, mastStartZ);
    return flag;
  }

  /** LOD2 (90-250 m): the same silhouette as the detail hull on the 18 x 8
   *  spline shell with the painted-wale team texture, a deck slab that follows
   *  the spline sheer, castle, bowsprit and masts merged into one timber draw,
   *  every sail one InstancedMesh draw (trimmed and hoisted per instance), and
   *  the flag: 4 draws. */
  private buildShipLod2(ship: Ship, stats: typeof SHIP_STATS[keyof typeof SHIP_STATS]) {
    const W = stats.width, L = stats.length, H = stats.height;
    const group = new THREE.Group();
    group.name = 'ship-lod2-root';
    const profile = getHullProfile(ship.type);
    const hullMat = new THREE.MeshStandardMaterial({ map: this.getTeamHullTexture(ship.teamColor), roughness: 0.85, metalness: 0.02 });
    hullMat.name = 'lod2-hull-shell';
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.95 });
    darkMat.name = 'lod2-timber';
    group.add(new THREE.Mesh(makeSplineHullGeometry(profile, 2), hullMat));
    const zr = sheerZRange(profile);
    const deck = new THREE.Mesh(makeLoftedSlabGeometry(profile, { topY: H + 0.1, thickness: 0.12, zFrom: zr.aft, zTo: zr.fore, inset: 0.04, samples: 14 }), darkMat);
    group.add(deck);
    const castle = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, H * 0.28, L * 0.22), darkMat);
    castle.position.set(0, H + H * 0.14, -L * 0.37);
    group.add(castle);
    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 5), darkMat);
    bowsprit.rotation.x = Math.PI * 0.5;
    bowsprit.rotation.z = -0.04;
    bowsprit.position.set(0, H + 0.48, L * 0.61);
    group.add(bowsprit);
    const rigPlan = getShipRigPlan(stats);
    const mastStartZ = rigPlan[0].z;
    for (const plan of rigPlan) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, plan.height, 5), darkMat);
      mast.position.set(0, H + plan.height * 0.5, plan.z);
      group.add(mast);
    }
    const slots = lodSailSlots(rigPlan);
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xeadfbf, roughness: 0.8, side: THREE.DoubleSide, map: this.getTeamSailTexture(ship.teamColor) });
    sailMat.name = 'lod2-sail-canvas';
    // b4.2g: LOD2 sails are a 6x4 bellied card, not a flat board.
    const sails = new THREE.InstancedMesh(makeLodSailCard(SAIL_CLOTH_GRID.lod2[0], SAIL_CLOTH_GRID.lod2[1], W * 0.09), sailMat, slots.length);
    sails.name = 'lod2-sails';
    sails.userData.lod2 = slots;
    group.add(sails);
    const flag = this.makeLodFlag(ship, rigPlan[0].truckY, mastStartZ);
    group.add(flag);
    mergeStaticMeshes(group, new Set<THREE.Object3D>([sails, flag]), shipLodKey(ship.type, 2));
    return { group, sails };
  }

  /** One vertex-coloured material for every hull's baked LOD1 parts. */
  private lod1Mat: THREE.MeshStandardMaterial | null = null;

  /** b4.2d LOD1 (30-90 m, D26 <= 35% of LOD0 tris, <= 12 draws). `detail` is
   *  the hull group BEFORE its static merge, so small parts can still be told
   *  apart and dropped; `accept` names what is baked and with which tone. */
  private buildShipLod1(
    ship: Ship,
    stats: typeof SHIP_STATS[keyof typeof SHIP_STATS],
    detail: THREE.Group,
    accept: (mesh: THREE.Mesh) => THREE.Color | null,
    key: string,
  ) {
    const W = stats.width;
    const group = new THREE.Group();
    group.name = 'ship-lod1-root';
    const profile = getHullProfile(ship.type);
    // No breach discard on this shell: a hole at 30-90 m is drawn by its
    // hole-vis group on the ship root; a see-through cut here would show a
    // hull with no hold behind it.
    const hullMat = new THREE.MeshStandardMaterial({ map: this.getTeamHullTexture(ship.teamColor), roughness: 0.84, metalness: 0.02, side: THREE.DoubleSide });
    hullMat.name = 'lod1-hull-shell';
    const shell = new THREE.Mesh(makeSplineHullGeometry(profile, 1), hullMat);
    shell.castShadow = true;
    shell.receiveShadow = true;
    group.add(shell);
    const baked = bakeVertexColorMerge(detail, accept, LOD1_MIN_PART_RADIUS, key);
    if (baked) {
      if (!this.lod1Mat) {
        this.lod1Mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 });
        this.lod1Mat.name = 'lod1-baked';
      }
      const parts = new THREE.Mesh(baked, this.lod1Mat);
      parts.name = 'lod1-baked';
      parts.castShadow = true;
      parts.receiveShadow = true;
      group.add(parts);
    }
    const rigPlan = getShipRigPlan(stats);
    const mastStartZ = rigPlan[0].z;
    const slots = lodSailSlots(rigPlan);
    // A bellied sail (forward bulge to 9% of the beam) on the LOD1 12x8 grid:
    // a unit card scaled per instance, the belly in metres (b4.2g).
    const sailGeo = makeLodSailCard(SAIL_CLOTH_GRID.lod1[0], SAIL_CLOTH_GRID.lod1[1], W * 0.09);
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xeadfbf, roughness: 0.8, side: THREE.DoubleSide, map: this.getTeamSailTexture(ship.teamColor) });
    sailMat.name = 'lod1-sail-canvas';
    const sails = new THREE.InstancedMesh(sailGeo, sailMat, slots.length);
    sails.name = 'lod1-sails';
    sails.userData.lod2 = slots;
    group.add(sails);
    group.add(this.makeLodFlag(ship, rigPlan[0].truckY, mastStartZ));
    return { group, sails };
  }

  /** Breaches are ENTITIES: diff the wire list against the decals already
   *  built, keyed by ShipHole.id (detail hull and, b4.2d, LOD1: the groups hang
   *  on the ship root, so they read at 30-90 m too). Returns the open count. */
  private syncHoleVis(mesh: ShipMeshGroup, ship: Ship, t: number, breachNear: boolean): number {
    const dbg = this.breachDebug;
    const holes = dbg && dbg.shipId === ship.id ? [...(ship.holes ?? []), ...dbg.holes] : ship.holes ?? [];
    let holeSlot = 0;
    for (const hole of holes) {
      let vis = mesh.holeVis.get(hole.id);
      if (vis && vis.size !== (hole.size ?? 1)) {
        // Enlarged (b2.2b): a bigger tear, a new outline and patch size.
        this.disposeHoleVis(mesh, vis);
        mesh.holeVis.delete(hole.id);
        vis = undefined;
      }
      if (!vis) {
        vis = this.buildHoleVis(mesh, hole);
        mesh.holeVis.set(hole.id, vis);
      } else if (
        Math.abs(hole.x - vis.src.x) + Math.abs(hole.y - vis.src.y) + Math.abs(hole.z - vis.src.z) > 1e-3
      ) {
        // Fire burn-down or a recycled slot at the cap: same id, new wound.
        this.reseatHoleVis(mesh, hole, vis);
      }
      if (hole.patched !== vis.patched) {
        vis.patched = !!hole.patched;
        if (vis.patched) {
          // Carpentry shows: planks go on, the wound stops reading as open.
          if (!vis.patch) this.addPlankPatch(mesh, vis, hole.id);
        } else if (vis.patch) {
          // The cap recycled this slot — the plank was blown back off.
          this.dropPlankPatch(mesh, vis);
        }
      }
      const open = !vis.patched;
      vis.group.visible = open;
      vis.marker.visible = open && !ship.sinking;
      vis.inboard.visible = open && vis.hasSeat && breachNear;
      vis.backdrop.visible = open && breachNear;
      if (open && holeSlot < mesh.hullHoleUniform.value.length) {
        mesh.hullHoleEnds.value[holeSlot].set(vis.inner.x, vis.inner.y, vis.inner.z, 0);
        // One shader slot per OPEN breach at its size radius (b2.2b), torn
        // along the strake by its own seeded outline (b2.3d).
        mesh.hullHoleUniform.value[holeSlot].set(vis.point.x, vis.point.y, vis.point.z, vis.R);
        mesh.hullHoleUniform.shape.value[holeSlot].set(vis.tangent.x, vis.tangent.y, vis.tangent.z, vis.seed);
        holeSlot += 1;
      }
    }
    if (mesh.holeVis.size !== holes.length) {
      const live = new Set(holes.map((h) => h.id));
      for (const [id, vis] of mesh.holeVis) {
        if (live.has(id)) continue;
        this.disposeHoleVis(mesh, vis);
        mesh.holeVis.delete(id);
      }
    }
    const markerPulse = 1 + 0.09 * Math.sin(t * 3.4 + 1.2);
    for (const vis of mesh.holeVis.values()) {
      if (vis.marker.visible) vis.marker.scale.setScalar(markerPulse * vis.markerScale);
    }
    const openBreaches = holeSlot;
    for (; holeSlot < mesh.hullHoleUniform.value.length; holeSlot++) {
      mesh.hullHoleUniform.value[holeSlot].set(0, 0, 0, 0);
      mesh.hullHoleEnds.value[holeSlot].set(0, 0, 0, 0);
    }
    return openBreaches;
  }

  private readonly lodMat = new THREE.Matrix4();
  private readonly lodQuat = new THREE.Quaternion();
  private readonly lodEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly lodPos = new THREE.Vector3();
  private readonly lodScale = new THREE.Vector3();

  /** Trim and hoist the LOD2 sails (one instance per mast). */
  private updateLod2Sails(mesh: ShipMeshGroup, ship: Ship, dt: number, sails = mesh.lod2Sails) {
    const k = 1 - Math.exp(-8 * dt);
    mesh.lod2SailAngle = THREE.MathUtils.lerp(mesh.lod2SailAngle, ship.sailAngle, k);
    mesh.lod2SailScale = THREE.MathUtils.lerp(mesh.lod2SailScale, Math.max(0.18, ship.sailHeight), k);
    sails.visible = ship.sailHeight > 0.06;
    const slots = sails.userData.lod2 as LodSailSlot[];
    this.lodEuler.set(0.055, mesh.lod2SailAngle, 0, 'YXZ');
    this.lodQuat.setFromEuler(this.lodEuler);
    for (let i = 0; i < slots.length; i++) {
      // Hangs from its yard; the topsail goes away first (sailHoistFor).
      const slot = slots[i];
      const hoist = Math.max(0.001, sailHoistFor(slot.kind, mesh.lod2SailScale));
      this.lodPos.set(0, slot.headY - slot.h * hoist * 0.5, slot.z);
      this.lodScale.set(slot.w, slot.h * hoist, 1);
      sails.setMatrixAt(i, this.lodMat.compose(this.lodPos, this.lodQuat, this.lodScale));
    }
    sails.instanceMatrix.needsUpdate = true;
  }

  /** Phones: every other hull starts at LOD2 (D26). Set by the client boot. */
  private lodPhone = false;
  setLodPhone(phone: boolean) { this.lodPhone = phone; }

  buildShip(ship: Ship): THREE.Group {
    const stats = SHIP_STATS[ship.type];
    const group = new THREE.Group();
    group.name = `ship_${ship.id}`;
    // ── WHICH AXIS IS "PITCH"? ────────────────────────────────────────────
    // three's default Euler order is XYZ, i.e. R = Rx·Ry·Rz, which applies the
    // yaw BEFORE the pitch and so swings the hull about WORLD X. World X is the
    // beam axis only on a north/south heading: sailing east or west the very
    // same `rotation.x` rolls the ship and the bow never dips, and roll leaks
    // into pitch the other way. The server sends BODY-axis pitch/roll
    // (PhysicsSystem.applyShipWaveAttitude) and floods each breach from body
    // axes (evaluateHoleFlood), so on three quarters of all headings the drawn
    // hull and the simulated one disagreed about which end was under water.
    // 'YXZ' = yaw first, then pitch about the yawed beam, then roll about the
    // fore-and-aft axis: exactly the server's convention. (ships-01, SHIP-01.)
    group.rotation.order = 'YXZ';
    const proxySails: THREE.Mesh[] = [];

    // Natural dark wood hull — NO team tint on the whole hull. Team color goes on
    // the painted sheer stripe (in the texture), flag cloth and main-sail band only.
    // NAMED, and not for the debugger's sake. The overdraw census keys a "part"
    // off the material, and every textured MeshStandardMaterial here leaves
    // `color` at white — so unnamed, the hull, the deck, the timber and the
    // barrels all reported as one surface called Standard#ffffff carrying 1.1
    // layers, which is a number with nowhere to send it. A name costs nothing
    // and makes the fill report say which plank.
    const hullMat = new THREE.MeshStandardMaterial({
      map: this.getTeamHullTexture(ship.teamColor),
      roughness: 0.82,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    hullMat.name = 'ship-hull-shell';
    const darkMat = new THREE.MeshStandardMaterial({
      map: this.darkWoodTex,
      roughness: 0.92,
      metalness: 0.0,
    });
    darkMat.name = 'ship-dark-timber';
    /**
     * THE CAP RAILS, AND WHY THEY CANNOT SHARE `darkMat`.
     *
     * The side railing and the cap rail are both dark timber and both reach the
     * hull's own half-beam exactly:
     *
     *   railing  x = W*0.5 - 0.07, box 0.14 wide  →  outboard face at  W*0.5
     *   cap rail x = W*0.48,       box 0.20 wide  →  outboard face at  W*0.5
     *
     * so they present ONE plane to anything alongside, over the cap rail's whole
     * 0.1 m height and the railing's whole 0.82·L run: a 9.6 m ribbon down each
     * side of the ship. Measured at `hull-alongside`, 128 tie pixels with a fully
     * tied 3x3 neighbourhood, all of them at hull-local x = 2.5 with a +x normal.
     *
     * Being the SAME material is what makes this one different from the
     * quarterdeck's: `mergeStaticMeshes` puts both surfaces in one draw, so there
     * is nothing to bias relative to anything. The cap has to become its own
     * material to be offset at all — and the cap reading in front of the rail it
     * caps is also what it should look like.
     */
    const darkTrimMat = darkMat.clone();
    darkTrimMat.name = 'ship-dark-trim';
    darkTrimMat.polygonOffset = true;
    darkTrimMat.polygonOffsetFactor = -2;
    darkTrimMat.polygonOffsetUnits = -2;
    const deckMat = new THREE.MeshStandardMaterial({
      map: this.deckTex,
      roughness: 0.78,
      metalness: 0.0,
    });
    deckMat.name = 'ship-deck-planking';
    /**
     * THE QUARTERDECK RISERS, AND WHY THEY NEED THEIR OWN MATERIAL.
     *
     * On the sloop the upper step's forward face and the stern castle's forward
     * face are THE SAME PLANE, and not by accident — by arithmetic:
     *
     *   step front  = -L·0.235 - stepDepth/2 = -L·0.235 - 0.3
     *   castle front = -L·0.37 + L·0.11      = -L·0.26
     *
     * which are equal exactly when L·0.025 = 0.3, i.e. L = 12, i.e. the sloop —
     * the hull every player starts in. Both faces point at the bow, they overlap
     * over the step's whole 2.0 x 0.45 m front, and the depth test has no way to
     * pick between them: measured 1,077 tie pixels with a whole 3x3 neighbourhood
     * tied, flipping between planking brown and near-black at 30-40 levels.
     *
     * The fix cannot be to move either box. Nudging them apart in world space
     * relocates the tie to whatever distance quantises the new gap to zero —
     * which for a 1 mm gap is anywhere past about 40 m — instead of removing it.
     * A polygon offset is a bias in DEPTH, so it holds at every distance.
     *
     * It costs one merged draw per detail hull, because `mergeStaticMeshes`
     * batches by material and this is a second one. The steps are two small boxes
     * and they only exist on the detail hull, so that is the whole bill.
     */
    const deckRiserMat = deckMat.clone();
    deckRiserMat.name = 'ship-deck-riser';
    deckRiserMat.polygonOffset = true;
    deckRiserMat.polygonOffsetFactor = -2;
    deckRiserMat.polygonOffsetUnits = -2;
    // SHIPVIS-01 phase A. Procedural planking on the two surfaces the player is
    // nose-to-nose with all match. `deckRiserMat` is patched separately because
    // three's Material.copy does NOT carry onBeforeCompile across a clone — the
    // riser would otherwise be the one un-planked patch of deck on the ship.
    // Costs no draws, no triangles and no bytes; the low tier compiles the
    // colour-only variant (no bevel normal, no grain). Distant hulls use the
    // proxy, which is never patched — that is the LOD.
    const plankUniforms = makePlankUniforms();
    const plankHighTier = this.quality !== 'low';
    applyPlankDetail(deckMat, 'deck', plankUniforms, plankHighTier);
    applyPlankDetail(deckRiserMat, 'deck', plankUniforms, plankHighTier);
    const sailMat = new THREE.MeshStandardMaterial({
      map: this.sailTex,
      color: 0xf5edd2,
      roughness: 0.68,
      emissive: 0x221a08,
      emissiveIntensity: 0.04,
      side: THREE.DoubleSide,
    });
    sailMat.name = 'ship-sail-canvas';
    // Muted painted team accent — desaturated toward timber, NO emissive.
    // Saturated team color lives only on flag / pennant / sail band.
    const accent = new THREE.Color(ship.teamColor).lerp(new THREE.Color(0x3a2a18), 0.4);
    const teamAccentMat = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.72,
      metalness: 0.04,
    });
    teamAccentMat.name = 'ship-team-accent';
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x484848, roughness: 0.4, metalness: 0.88 });
    metalMat.name = 'ship-iron';
    const brassHardwareMat = new THREE.MeshStandardMaterial({ color: 0x9A6E28, roughness: 0.42, metalness: 0.82 });
    brassHardwareMat.name = 'ship-brass';
    const ropeCoilMat = new THREE.MeshStandardMaterial({ color: 0x9a8050, roughness: 1 });
    ropeCoilMat.name = 'ship-rope';
    const barrelWoodMat = new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.92 });
    barrelWoodMat.name = 'ship-barrel-wood';

    const W = stats.width, L = stats.length, H = stats.height;
    const upgradeVisuals: Record<ShipUpgradeType, THREE.Object3D[]> = {
      hull_reinforcement: [],
      charged_cannons: [],
      swift_sails: [],
      lightning_rod: [],
    };

    // ── Hull ─────────────────────────────────────────────────
    // Lofted shell: rounded bilge, tumblehome, flared raked bow, real draft.
    // Only the SHELL changed — deck plane, rails, cannon/mast positions and the
    // walkable footprint (sheer half-widths) are identical to the server tables.
    const profile = getHullProfile(ship.type);
    // b4.2d: the shell IS the shared spline at tier resolution (LOD0 72 x 40
    // per side). The low tier draws its one LOD0 hull (the one you stand on)
    // on the LOD1 grid so the whole hull stays under its 60k cap.
    const hullGeo = makeSplineHullGeometry(profile, this.quality === 'low' ? 1 : 0);
    // b4.2e: strake-space coordinates for plank shader v2 (strakes follow the
    // sheer into the stem, same count at the stem as amidships).
    addStrakeSpace(hullGeo);
    // REAL see-through breaches: the fragment shader discards hull planking
    // inside each active hole (hull-local space — the loft mesh sits at
    // identity in the ship group, so `position` IS hull-local). The material
    // is DoubleSide, so looking through an opening shows the far interior
    // wall instead of vanished backfaces.
    const holeSlots = FLOODING.MAX_HOLES_PER_SHIP;
    const hullHoleUniform: HullHoleUniform = {
      value: Array.from({ length: holeSlots }, () => new THREE.Vector4(0, 0, 0, 0)),
      shape: { value: Array.from({ length: holeSlots }, () => new THREE.Vector4(0, 0, 1, 0)) },
    };
    applyHullHoleDiscard(hullMat, hullHoleUniform, holeSlots);
    const hullHoleEnds = { value: Array.from({ length: holeSlots }, () => new THREE.Vector4(0, 0, 0, 0)) };
    // Chained AFTER the breach discard: applyPlankDetail calls whatever
    // onBeforeCompile it finds and folds the previous program-cache key into
    // its own, so the two patches compose instead of overwriting each other.
    applyPlankDetail(hullMat, 'hull', plankUniforms, plankHighTier);
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    // Waterline contact collar — the wet foam edge where the sea meets the
    // planking. The hull's DRAFT is already correct (the loft's y = 0 slot is
    // the design waterline and the render root rides the shared Gerstner
    // surface within ~0.05 m), but with no contact treatment the ocean just
    // clipped the shell with a hard silhouette and the hull's own shadow read
    // as an air gap under the keel. This collar is what makes it sit IN the sea.
    const waterlineFoam = buildWaterlineCollar(profile, this.waterlineFoamTex);
    group.add(waterlineFoam);

    // Breaches are NOT built here any more. A hole is an ENTITY at whatever
    // point the shot landed, so its decal is created on demand in update()
    // (see buildHoleVis) from the shared materials on this renderer.
    const sternStation = profile.stations[0];

    // Wales + boot-top: proud strakes that FOLLOW the loft (no more straight
    // boxes floating off the tapered bow/stern). Sheer strake under the cap
    // rail, main wale at the turn of the topside, boot-top at the waterline.
    // Own material (its own merge bucket, +1 draw per detail hull) so the
    // strakes can carry the hole discard: the boot-top crossed the bottom of
    // every waterline breach and the main wale crossed cannon holes (ships-07).
    const strakeMat = darkMat.clone();
    strakeMat.name = 'ship-hull-strake';
    applyTimberEnvLift(strakeMat);
    applyHullHoleDiscard(strakeMat, hullHoleUniform, holeSlots);
    for (const side of [1, -1] as const) {
      const sheerStrake = new THREE.Mesh(
        makeHullStrakeGeometry(profile, side, (st) => st.sheerY - H * 0.14, 0.055, H * 0.055),
        strakeMat,
      );
      sheerStrake.castShadow = true;
      group.add(sheerStrake);
      const mainWale = new THREE.Mesh(
        makeHullStrakeGeometry(profile, side, (st) => st.sheerY * 0.60, 0.07, H * 0.05),
        strakeMat,
      );
      mainWale.castShadow = true;
      group.add(mainWale);
      const bootTop = new THREE.Mesh(
        makeHullStrakeGeometry(profile, side, () => 0.08, 0.03, H * 0.045, 1, 7),
        strakeMat,
      );
      group.add(bootTop);
    }

    // Painted team band across the transom (side stripe lives in the hull
    // texture, so it follows the sheer curve exactly). Seat it ON the raked
    // stern surface at its height — a fixed -0.505L offset hovered it ~0.15m
    // aft of the counter (visible as a detached bar from above).
    const bowStation = profile.stations[profile.stations.length - 1];
    const transomBand = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.6, H * 0.09, 0.07),
      teamAccentMat,
    );
    transomBand.position.set(0, H * 0.82, stationSurfaceAt(sternStation, H * 0.82).z - 0.045);
    group.add(transomBand);

    // Hull-reinforcement upgrade: actual bolted armor belts, ribs, and bow/stern plates.
    {
      const armor = new THREE.Group();
      armor.name = 'upgrade-hull-reinforcement';
      armor.visible = false;
      const armorMat = new THREE.MeshStandardMaterial({
        color: 0x6f7e86,
        roughness: 0.34,
        metalness: 0.78,
        emissive: 0x0b1f2e,
        emissiveIntensity: 0.08,
      });
      const darkArmorMat = new THREE.MeshStandardMaterial({
        color: 0x2d3940,
        roughness: 0.5,
        metalness: 0.85,
      });
      // Belts, ribs, plates and rivets hug the same shell, so they take the same
      // breach discard (ships-07). Everything under here must therefore be
      // hull-local: the ribs and plates bake their offset into the geometry
      // instead of setting mesh.position, and the rivets are read through
      // instanceMatrix inside the patch.
      applyHullHoleDiscard(armorMat, hullHoleUniform, holeSlots);
      applyHullHoleDiscard(darkArmorMat, hullHoleUniform, holeSlots);
      // Armor belts follow the loft like the wales, so they hug the planking
      for (const side of [1, -1] as const) {
        const mainBelt = new THREE.Mesh(
          makeHullStrakeGeometry(profile, side, (st) => st.sheerY * 0.43, 0.1, H * 0.17, 1, 7),
          armorMat,
        );
        mainBelt.castShadow = true;
        armor.add(mainBelt);
        const upperBelt = new THREE.Mesh(
          makeHullStrakeGeometry(profile, side, (st) => st.sheerY * 0.70, 0.08, H * 0.1, 1, 7),
          darkArmorMat,
        );
        upperBelt.castShadow = true;
        armor.add(upperBelt);
      }
      for (const z of [-L * 0.34, -L * 0.08, L * 0.2, L * 0.39]) {
        const ribHalf = hullSurfacePointAt(profile, z, H * 0.52).x + 0.055;
        const rib = new THREE.Mesh(
          new THREE.BoxGeometry(ribHalf * 2, H * 0.13, 0.07).translate(0, H * 0.52, z),
          darkArmorMat,
        );
        rib.castShadow = true;
        armor.add(rib);
      }
      // Bow/stern plates hug the raked stem/counter at their own height — the
      // old fixed ±0.535/0.565·L offsets floated them 0.8-1.9m off the hull in
      // open air (the loft's stern surface at this height is only ~0.48L aft).
      const bowPlate = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.48, H * 0.34, 0.08)
          .translate(0, H * 0.52, stationSurfaceAt(bowStation, H * 0.52).z + 0.05),
        armorMat,
      );
      bowPlate.castShadow = true;
      armor.add(bowPlate);
      const sternPlate = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.82, H * 0.28, 0.08)
          .translate(0, H * 0.52, stationSurfaceAt(sternStation, H * 0.52).z - 0.05),
        armorMat,
      );
      sternPlate.castShadow = true;
      armor.add(sternPlate);

      const rivetGeo = new THREE.SphereGeometry(0.045, 6, 4);
      const rivets = new THREE.InstancedMesh(rivetGeo, darkArmorMat, 36);
      const matrix = new THREE.Matrix4();
      let index = 0;
      for (const sx of [-1, 1] as const) {
        for (let i = 0; i < 9; i++) {
          const z = -L * 0.36 + (i / 8) * L * 0.72;
          for (const y of [H * 0.36, H * 0.52]) {
            const surf = hullSurfacePointAt(profile, z, y);
            matrix.makeTranslation(sx * (surf.x + surf.nx * 0.1), y + surf.ny * 0.1, z);
            rivets.setMatrixAt(index++, matrix);
          }
        }
      }
      rivets.count = index;
      rivets.instanceMatrix.needsUpdate = true;
      rivets.castShadow = true;
      armor.add(rivets);
      group.add(armor);
      upgradeVisuals.hull_reinforcement.push(armor);
    }

    // Bow stem post follows the forward-raked stem curve of the loft, from the
    // waterline entry up past the sheer where the figurehead mounts.
    const bowStem = makeCylinderBetween(
      new THREE.Vector3(0, -profile.draft * 0.25, L * 0.425),
      new THREE.Vector3(0, H * 1.14, L * 0.538),
      0.105,
      darkMat,
      8,
    );
    group.add(bowStem);

    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 8), darkMat);
    bowsprit.rotation.x = Math.PI * 0.5;
    bowsprit.rotation.z = -0.04;
    bowsprit.position.set(0, H + 0.48, L * 0.61);
    bowsprit.castShadow = true;
    // b4.2h: the head stays are made fast ON this spar (ship/sails.ts).
    bowsprit.userData.rigSpar = 'bowsprit';
    group.add(bowsprit);

    // b4.3c: the carved figurehead is the Blender kit's, mounted on the stem
    // socket from the spline (ship/kit.ts) once the kit has streamed in.

    // Transom panel nests within the lofted stern (the loft's own raked cap
    // carries the shape below) instead of the old full-beam slab. On the
    // lifted strake material (b4.2e): on darkMat it was the black slab under
    // the stern windows at noon (gallery galleon stern).
    const sternTransom = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.64, H * 0.52, 0.14),
      strakeMat,
    );
    sternTransom.position.set(0, H * 0.66, -L * 0.505);
    sternTransom.castShadow = true;
    sternTransom.receiveShadow = true;
    group.add(sternTransom);

    // Sized to the planking at its own height, not to W: a fixed W.0.34 cap
    // 0.49 L forward is wider than the stem is there, so its 24 corners were the
    // last thing in the hull-shell family sitting outside the hull (ships-04).
    const bowCapY = H * 0.78;
    const bowCapZ = L * 0.49;
    const bowCapHalf = Math.max(0.08, hullSurfacePointAt(profile, bowCapZ, bowCapY).x - 0.02);
    const bowCap = new THREE.Mesh(
      new THREE.BoxGeometry(bowCapHalf * 2, H * 0.18, 0.12),
      hullMat,
    );
    bowCap.position.set(0, bowCapY, bowCapZ);
    bowCap.castShadow = true;
    group.add(bowCap);

    // External keel plank running under the new draft, plus a rudder blade
    // hung off the raked sternpost — the underwater body reads as a real hull.
    const keel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.28, L * 0.68), darkMat);
    keel.position.set(0, -profile.draft + 0.05, -L * 0.02);
    group.add(keel);
    // The blade hangs off a STOCK it can turn on (ships-12): rotation.y is the
    // rudder angle on the wire. Seated on the shared sternpost (ship/stern.ts).
    const rudderPivot = buildRudder(profile, darkMat);
    group.add(rudderPivot);

    // ── Stairwell hole (shared by the weather deck above and the interior ceiling below) ────────
    const halfDeckZ = L * 0.45;
    const companionway = getShipCompanionwayConfig(stats);
    const stairCenterX = companionway.cx;
    const voidHalfX = companionway.halfX;
    const voidHalfZ = companionway.halfZ;
    const holeCx = companionway.cx;
    const holeCz = companionway.cz;

    // ── Ship Interior (below deck) ────────────────────────────
    const interior = makeShipInterior(stats, deckMat, darkMat, {
      cx: holeCx,
      cz: holeCz,
      halfX: voidHalfX,
      halfZ: voidHalfZ,
    }, profile, this.quality, (m) => applyHullHoleDiscard(m, hullHoleUniform, holeSlots, hullHoleEnds));
    group.add(interior);

    // ── Hold cargo (the gold race, made physical) ─────────────
    // Crates and coin-spill that grow with the crew's banked gold. Excluded
    // from the static merge below (they are toggled per tier every frame) and
    // invisible until there is actually treasure aboard.
    const holdCargo = makeHoldCargoStacks(
      stats,
      new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.88, metalness: 0.02 }),
      new THREE.MeshStandardMaterial({
        color: 0xE0B44A, emissive: 0x6a4a10, emissiveIntensity: 0.55,
        roughness: 0.34, metalness: 0.72,
      }),
      ship.type,
    );
    group.add(holdCargo.group);

    // ── Hold water (b2.3a) ───────────────────────────────────
    // World-level free surface from the shared fill table, tilted in the hull
    // frame by the drawn attitude plus the client slosh re-sim, clipped per
    // fragment to the loft. See ship/holdWater.ts.
    const holdWater = createHoldWater(ship.type, this.quality);
    group.add(holdWater.mesh);
    group.add(holdWater.shaft);

    // ── Weather deck (split around stairwell — no hatch lids; open companionway like Sea of Thieves)

    // Weather deck: 4 box slabs around the stairwell so the hole is *real* geometry
    // (no fragile ShapeGeometry hole-punching). The bulwarks/rails added later hide
    // the rectangular outer edge.
    // Slab center such that the TOP face lands exactly on the server's standing
    // plane (ship.y + H + 0.1) — pirates stand ON the planks, not ankle-deep.
    // ONE lofted slab, not five boxes. The old deck was W·0.95 wide from
    // -0.45 L to 0.45 L: at the galleon's bow the hull is 0.27 W there, so
    // 2.54 m of planking hung over open water (ships-04). This follows the
    // sheer at every z and carries the companionway as a real hole.
    const deckSurfaceY = H + SHIP.DECK_STAND_OFFSET;
    const midDepth = Math.max(0, voidHalfZ * 2);
    if (deckMat.map) {
      deckMat.map.wrapS = THREE.RepeatWrapping;
      deckMat.map.wrapT = THREE.RepeatWrapping;
      deckMat.map.needsUpdate = true;
    }
    const deckRepX = deckMat.map ? deckMat.map.repeat.x || 1 : 1;
    const deckRepY = deckMat.map ? deckMat.map.repeat.y || 1 : 1;
    const weatherDeck = new THREE.Mesh(
      makeLoftedSlabGeometry(profile, {
        topY: deckSurfaceY,
        thickness: 0.15,
        zFrom: -halfDeckZ,
        zTo: halfDeckZ,
        hole: { cx: holeCx, cz: holeCz, halfX: voidHalfX, halfZ: voidHalfZ },
        // Plank pitch is a LENGTH, not a fraction of the hull: 1.4 m across the
        // beam, 0.9 m fore-and-aft on every class (ships-19).
        uvScaleX: 1 / (1.4 * deckRepX),
        uvScaleY: 1 / (0.9 * deckRepY),
      }),
      deckMat,
    );
    weatherDeck.receiveShadow = true;
    weatherDeck.castShadow = true;
    group.add(weatherDeck);

    // Trim coamings around the companionway (no hatch — just raised lip)
    const coamingMat = darkMat;
    for (const sx of [-1, 1] as const) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, midDepth + 0.08), coamingMat);
      lip.position.set(holeCx + sx * (voidHalfX + 0.05), H + 0.08, holeCz);
      lip.castShadow = true;
      group.add(lip);
    }
    for (const sz of [-1, 1] as const) {
      const endLip = new THREE.Mesh(new THREE.BoxGeometry(voidHalfX * 2 + 0.24, 0.1, 0.12), coamingMat);
      endLip.position.set(holeCx, H + 0.07, holeCz + sz * (voidHalfZ + 0.05));
      endLip.castShadow = true;
      group.add(endLip);
    }

    // Cargo-hold hatch grating amidships (forward of the companionway) — light and
    // rising floodwater read through its slats from above.
    {
      const grateW = Math.min(W * 0.34, 1.4);
      const grateL = Math.min(L * 0.16, 1.5);
      const grating = makeHatchGrating(grateW, grateL, darkMat, coamingMat);
      grating.position.set(W * 0.2, H + 0.13, holeCz + voidHalfZ + grateL * 0.65 + 0.22);
      group.add(grating);
    }

    // Stairwell down to the hold: a single solid run with broad treads, so there
    // is no floating plank gap or invisible divider between decks.
    const stairTopY = H + 0.03;
    const stairBottomY = 0.43;
    const stairFrontZ = companionway.stairFrontZ - Math.max(0.16, L * 0.012);
    const stairBackZ = companionway.stairBackZ;
    const stairWidth = companionway.stairHalfWidth * 2 - 0.18;
    const stairRun = Math.max(0.5, stairFrontZ - stairBackZ);
    const stairBody = new THREE.Mesh(
      makeStairRampGeometry(stairWidth, stairTopY, stairBottomY, stairFrontZ, stairBackZ, 0.22),
      deckMat,
    );
    stairBody.position.x = stairCenterX;
    stairBody.castShadow = true;
    stairBody.receiveShadow = true;
    group.add(stairBody);

    const stairStepCount = ship.type === 'sloop' ? 6 : ship.type === 'brigantine' ? 7 : 8;
    const treadDepth = Math.min(0.72, stairRun / stairStepCount * 0.82);
    for (let step = 0; step < stairStepCount; step++) {
      const stepMesh = new THREE.Mesh(
        new THREE.BoxGeometry(stairWidth, 0.09, treadDepth),
        deckMat,
      );
      const progress = step / Math.max(1, stairStepCount - 1);
      const y = stairTopY + (stairBottomY - stairTopY) * progress;
      const z = stairFrontZ + (stairBackZ - stairFrontZ) * progress;
      stepMesh.position.set(
        stairCenterX,
        y + 0.035,
        z,
      );
      stepMesh.castShadow = true;
      stepMesh.receiveShadow = true;
      group.add(stepMesh);
    }

    for (const sx of [-1, 1] as const) {
      const railX = stairCenterX + sx * (stairWidth * 0.5 + 0.13);
      const railStart = new THREE.Vector3(railX, stairTopY + 0.42, stairFrontZ - 0.06);
      const railEnd = new THREE.Vector3(railX, stairBottomY + 0.5, stairBackZ + 0.08);
      const handrail = makeCylinderBetween(railStart, railEnd, 0.036, darkMat, 8);
      group.add(handrail);
      for (let p = 0; p < 4; p++) {
        const progress = p / 3;
        const z = THREE.MathUtils.lerp(stairFrontZ - 0.08, stairBackZ + 0.08, progress);
        const baseY = THREE.MathUtils.lerp(stairTopY - 0.01, stairBottomY + 0.03, progress);
        const topY = THREE.MathUtils.lerp(railStart.y, railEnd.y, progress);
        const post = makeCylinderBetween(
          new THREE.Vector3(railX, baseY, z),
          new THREE.Vector3(railX, topY, z),
          0.027,
          darkMat,
          7,
        );
        group.add(post);
      }
    }

    // ── Railings ─────────────────────────────────────────────
    const railH = 0.58, railThick = 0.07;
    const addRail = (x: number, z: number, rw: number, rl: number) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(rw, railH, rl), darkMat);
      r.position.set(x, H + railH * 0.5, z);
      group.add(r);
    };
    // The side runs follow the sheer (they used to be straight at 0.5 W, i.e.
    // outboard of the hull over the whole forward third); the stern run is
    // transverse, so a box sized to the transom's own beam is right.
    for (const side of [-1, 1] as const) {
      const rail = new THREE.Mesh(
        makeSheerRunGeometry(profile, side, {
          y0: H, y1: H + railH, thickness: railThick * 2, zFrom: -halfDeckZ, zTo: halfDeckZ, inset: 0.16,
        }),
        darkMat,
      );
      group.add(rail);
    }
    addRail(0, -L * 0.41, sheerHalfWidthAt(profile, -L * 0.41) * 2, railThick * 2);

    // ── Bulwark + cap rail, lofted ────────────────────────────
    // Both used to be straight runs (bulwark 0.44 W, cap rail 0.48 W, carried
    // 0.78-0.82 L) with three hand-placed patches at the bow to hide where they
    // left the hull. On a galleon the cap rail sat 1.49 m outboard of her own
    // topside. Now each is ONE run per side on the sheer curve, closed by a
    // transverse breastwork at each end of the deck, so the bow needs no patch.
    const bulwarkH = 0.34;
    const bulwarkTop = H + bulwarkH;
    for (const side of [-1, 1] as const) {
      const bulwark = new THREE.Mesh(
        makeSheerRunGeometry(profile, side, {
          // y0 is the deck's WALKING surface, not H: the weather-deck slab's
          // edge runs on this same sheer outline up to deckSurfaceY, and both
          // are ship-deck-planking in one merged draw, so from H the two outer
          // faces shared a band of plane (hull-alongside patch ties, b1 gate).
          y0: deckSurfaceY, y1: bulwarkTop, thickness: 0.14, zFrom: -halfDeckZ, zTo: halfDeckZ,
        }),
        deckMat,
      );
      bulwark.castShadow = true;
      bulwark.receiveShadow = true;
      group.add(bulwark);
      const capRail = new THREE.Mesh(
        makeSheerRunGeometry(profile, side, {
          y0: bulwarkTop, y1: bulwarkTop + 0.1, thickness: 0.2, zFrom: -halfDeckZ, zTo: halfDeckZ,
        }),
        darkTrimMat,
      );
      capRail.castShadow = true;
      group.add(capRail);
    }
    for (const endZ of [-halfDeckZ, halfDeckZ] as const) {
      const endHalf = sheerHalfWidthAt(profile, endZ);
      const breastwork = new THREE.Mesh(new THREE.BoxGeometry(endHalf * 2, bulwarkH, 0.16), deckMat);
      breastwork.position.set(0, H + bulwarkH * 0.5, endZ + (endZ < 0 ? 0.08 : -0.08));
      breastwork.castShadow = true;
      group.add(breastwork);
      const endCap = new THREE.Mesh(new THREE.BoxGeometry(endHalf * 2, 0.1, 0.22), darkTrimMat);
      endCap.position.set(0, bulwarkTop + 0.05, endZ + (endZ < 0 ? 0.08 : -0.08));
      endCap.castShadow = true;
      group.add(endCap);
    }

    // Railing stanchions
    const stanchionCount = Math.max(4, Math.round(L / 3));
    for (let s = 0; s < stanchionCount; s++) {
      const sz = L * 0.41 - s * (L * 0.82 / stanchionCount);
      for (const sx of [-1, 1]) {
        const stanchion = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, railH, 6),
          darkMat,
        );
        stanchion.position.set(sx * (sheerHalfWidthAt(profile, sz) - 0.16 - railThick), H + railH * 0.5, sz);
        group.add(stanchion);
      }
    }

    // Boarding ladders on both sides
    const ladderTop = H + 0.42;
    const ladderBottom = 0.35;
    const ladderHeight = ladderTop - ladderBottom;
    const ladderRopeMat = ropeCoilMat;
    const ladderRungMat = darkMat;
    // DRAPED, not hung in the air. The ladder was two vertical cylinders and six
    // rungs at a fixed 0.56 W: the hull tumbles home below the wale, so on a
    // galleon the bottom of every ladder stood 0.97 m off her side and a pirate
    // climbed a rope ladder with a metre of daylight behind it (ships-10). Each
    // stile now runs between the planking's own surface points at its top and
    // bottom, and each rung sits on the surface at its own height.
    for (const ladder of getShipBoardingLadderLocals(ship.type)) {
      const ladderSide = ladder.x >= 0 ? 1 : -1;
      const surfaceX = (z: number, y: number) => ladderSide * (hullSurfacePointAt(profile, z, y).x + 0.035);
      for (const ropeOffset of [-0.14, 0.14]) {
        const rz = ladder.z + ropeOffset;
        const rope = makeCylinderBetween(
          new THREE.Vector3(surfaceX(rz, ladderBottom), ladderBottom, rz),
          new THREE.Vector3(surfaceX(rz, ladderTop), ladderTop, rz),
          0.018,
          ladderRopeMat,
          6,
        );
        group.add(rope);
      }
      for (let rung = 0; rung < 6; rung++) {
        const rungY = ladderBottom + 0.2 + rung * (ladderHeight - 0.4) / 5;
        const rungMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.022, 0.34, 6),
          ladderRungMat,
        );
        rungMesh.rotation.x = Math.PI * 0.5;
        rungMesh.position.set(surfaceX(ladder.z, rungY) + ladderSide * 0.025, rungY, ladder.z);
        group.add(rungMesh);
      }
    }

    // ── Stern castle (ship/stern.ts) ──
    // On the strake material, not darkMat (b4.2e): the castle is outboard
    // planking and needs the env lift that keeps the transom off black at noon,
    // while darkMat also builds the hold, which is lit by its lanterns. Sharing
    // the strakes' merge bucket costs no draw (a material of its own broke the
    // LOD0 draw ratchet by one), and a breach at the stern now cuts the castle
    // wall it passes through, as it should.
    buildSternCastle(group, profile, sternStation, strakeMat, brassHardwareMat);

    // ── Quarterdeck: a genuinely RAISED helm dais at the stern (config-driven so
    //    the geometry matches the server's raised foot height exactly). The wheel
    //    sits on it, a two-step run leads up, and a low rail wraps the back. ──
    const qd = getShipQuarterdeckConfig({ width: W, length: L });
    const qdRise = qd.rise;                       // ~0.45m — a real step-up, not a curb
    const qdZ = qd.cz;
    const qdLen = qd.halfZ * 2, qdW = qd.halfX * 2;
    // Flat dais covers the aft footprint; the forward stepDepth is the stair run.
    const flatFrontZ = qd.frontZ - qd.stepDepth;
    const flatLen = Math.max(0.5, flatFrontZ - qd.backZ);
    const quarterdeck = new THREE.Mesh(new THREE.BoxGeometry(qdW, qdRise, flatLen), deckMat);
    quarterdeck.position.set(0, H + qdRise * 0.5, (qd.backZ + flatFrontZ) * 0.5);
    quarterdeck.castShadow = true;
    quarterdeck.receiveShadow = true;
    group.add(quarterdeck);
    // Two-step run up the forward face — matches getShipDeckRaiseAt's ramp so feet
    // track the visible treads instead of walking through a vertical curb.
    const nSteps = 2;
    for (let si = 0; si < nSteps; si++) {
      const stepH = qdRise * (si + 1) / nSteps;
      const stepDepth = qd.stepDepth / nSteps;
      // deckRiserMat, not deckMat: the upper step's forward face is coplanar with
      // the stern castle's on the sloop — see the material's own note.
      const step = new THREE.Mesh(new THREE.BoxGeometry(qdW * 0.56, stepH, stepDepth), deckRiserMat);
      step.position.set(0, H + stepH * 0.5, qd.frontZ - (si + 0.5) * stepDepth);
      step.receiveShadow = true;
      step.castShadow = true;
      group.add(step);
    }
    // Low rail hugging the quarterdeck sides + stern (sits on the raised dais).
    for (const [rx, rz, rlen, rot] of [
      [-qdW * 0.5, qdZ, qdLen, 0], [qdW * 0.5, qdZ, qdLen, 0], [0, qdZ - qdLen * 0.5, qdW, Math.PI * 0.5],
    ] as const) {
      const railTop = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, rlen), darkMat);
      railTop.position.set(rx, H + qdRise + 0.62, rz);
      railTop.rotation.y = rot;
      group.add(railTop);
      // sin/cos, not cos/sin. The rail BOX is rotated by rot, so its length runs
      // along +z at rot 0 and along +x at rot pi/2 — and the balusters have to
      // march the same way. Written the other way round, the stern rail's three
      // posts walked AFT down the centreline instead of across the beam: on a
      // galleon the last one stood 0.85 m behind the transom, in the air, which
      // is exactly what test-ship-geometry's stern rule had been reporting as
      // "ship-dark-timber" since the gate was written (ships-05).
      for (const t of [-0.36, 0, 0.36]) {
        const baluster = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.62, 5), darkMat);
        baluster.position.set(rx + Math.sin(rot) * t * rlen, H + qdRise + 0.31, rz + Math.cos(rot) * t * rlen);
        group.add(baluster);
      }
    }

    // Helm wheel (seated on the quarterdeck dais). Scaled with hull class so the
    // galleon's wheel reads bigger than the sloop's instead of one fixed size,
    // and rounded out (higher-segment rim/spokes) since it's the hero helm object
    // right in front of the captain.
    const wheelScale = 0.9 + Math.min(0.42, Math.max(0, (L - 12) / 26));
    const rimR = 0.4 * wheelScale;
    const spokeLen = rimR * 1.42;
    const wheelPost = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 1.06, 10), darkMat);
    wheelPost.position.set(0, H + qdRise + 0.53, -L * 0.315);
    wheelPost.castShadow = true;
    group.add(wheelPost);

    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(0, H + qdRise + 0.74 + rimR, -L * 0.315);
    group.add(wheelGroup);

    const wheelBase = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.13, 12), metalMat);
    wheelBase.rotation.x = Math.PI * 0.5;
    wheelBase.castShadow = true;
    wheelGroup.add(wheelBase);

    const wheelRim = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.055 * wheelScale, 12, 28), metalMat);
    wheelRim.castShadow = true;
    wheelGroup.add(wheelRim);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.2, 12), metalMat);
    hub.rotation.x = Math.PI * 0.5;
    hub.castShadow = true;
    wheelGroup.add(hub);

    const spokeCount = 8;
    for (let spoke = 0; spoke < spokeCount; spoke++) {
      const ang = (spoke / spokeCount) * Math.PI * 2;
      const spokeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, spokeLen, 8), darkMat);
      spokeMesh.rotation.z = ang;
      wheelGroup.add(spokeMesh);

      // Turned handle pegs jutting past the rim on every spoke (classic ship's wheel).
      const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.16, 8), darkMat);
      peg.rotation.x = Math.PI * 0.5;
      peg.position.set(Math.cos(ang) * (rimR + 0.02), Math.sin(ang) * (rimR + 0.02), 0.06);
      wheelGroup.add(peg);
    }
    // b3.3c: peg grips for the helmsman's hand IK, local to the spinning wheel.
    wheelGroup.userData[IK_GRIPS_KEY] = { kind: 'helm', points: Array.from({ length: spokeCount }, (_, i) => new THREE.Vector3(Math.cos(i / spokeCount * Math.PI * 2) * (rimR + 0.02), Math.sin(i / spokeCount * Math.PI * 2) * (rimR + 0.02), 0.1)) };

    // Compass binnacle at the foot of the helm steps (on the main deck, just
    // forward of the raised dais so it doesn't sink into the platform).
    const compassX = W * 0.19;
    const compassZ = -L * 0.205;
    const binnacle = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.72, 10), darkMat);
    binnacle.position.set(compassX, H + 0.48, compassZ);
    binnacle.castShadow = true;
    group.add(binnacle);
    const compassTop = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.08, 18), brassHardwareMat);
    compassTop.position.set(compassX, H + 0.87, compassZ);
    group.add(compassTop);
    const compassFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.225, 24),
      new THREE.MeshStandardMaterial({ color: 0xf4e0ad, roughness: 0.72, metalness: 0.05, side: THREE.DoubleSide }),
    );
    compassFace.rotation.x = -Math.PI * 0.5;
    compassFace.position.set(compassX, H + 0.916, compassZ);
    group.add(compassFace);
    const compassNeedle = new THREE.Group();
    compassNeedle.position.set(compassX, H + 0.928, compassZ);
    const northNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.018, 0.29), new THREE.MeshStandardMaterial({ color: 0xc52f24, roughness: 0.5 }));
    northNeedle.position.z = 0.072;
    const southNeedle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 0.22), new THREE.MeshStandardMaterial({ color: 0x253044, roughness: 0.5 }));
    southNeedle.position.z = -0.055;
    compassNeedle.add(northNeedle, southNeedle);
    group.add(compassNeedle);
    for (let tick = 0; tick < 8; tick++) {
      const mark = new THREE.Mesh(
        new THREE.BoxGeometry(tick % 2 === 0 ? 0.018 : 0.012, 0.012, tick % 2 === 0 ? 0.07 : 0.045),
        new THREE.MeshStandardMaterial({ color: tick === 0 ? 0xb7241f : 0x263147, roughness: 0.6 }),
      );
      const angle = (tick / 8) * Math.PI * 2;
      mark.position.set(compassX + Math.sin(angle) * 0.16, H + 0.932, compassZ + Math.cos(angle) * 0.16);
      mark.rotation.y = angle;
      group.add(mark);
    }

    // Bow anchor capstan: a clear manual wheel station for dropping / raising anchor.
    const anchorCapstan = new THREE.Group();
    anchorCapstan.position.set(0, H + 0.1, L * 0.42);
    const capstanPost = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 0.78, 12), darkMat);
    capstanPost.position.y = 0.39;
    capstanPost.castShadow = true;
    anchorCapstan.add(capstanPost);
    const capstanBand = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.12, 12), brassHardwareMat);
    capstanBand.position.y = 0.66;
    capstanBand.castShadow = true;
    anchorCapstan.add(capstanBand);
    const capstanWheel = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.055, 8, 30), brassHardwareMat);
    capstanWheel.rotation.x = Math.PI * 0.5;
    capstanWheel.position.y = 0.88;
    capstanWheel.castShadow = true;
    anchorCapstan.add(capstanWheel);
    // Hub column ties the wheel ring onto the post (post top y=0.78, ring y=0.88)
    const capstanHub = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.23, 0.24, 12), darkMat);
    capstanHub.position.y = 0.86;
    capstanHub.castShadow = true;
    anchorCapstan.add(capstanHub);
    let capstanGrip: THREE.Mesh | undefined;
    // b3.3c: bar-end knob grips for the capstan pusher's hand IK.
    anchorCapstan.userData[IK_GRIPS_KEY] = { kind: 'capstan', points: Array.from({ length: 8 }, (_, i) => new THREE.Vector3(Math.cos(i / 8 * Math.PI * 2) * 0.66, 0.88, -Math.sin(i / 8 * Math.PI * 2) * 0.66)) };
    // Four bars, each spanning the full wheel, give the eight spoke ends. Eight
    // bars at 45 deg steps drew every bar twice (spoke k and k+4 are the same
    // box turned 180 deg), a coplanar pair that fought on every face and doubled
    // the knobs; the z-fighting hold-flooded stand saw it through the hatch.
    for (let spoke = 0; spoke < 4; spoke++) {
      const angle = (spoke / 8) * Math.PI * 2;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.075, 0.095), darkMat);
      handle.position.y = 0.88;
      handle.rotation.y = angle;
      handle.castShadow = true;
      if (spoke === 0) {
        handle.name = 'capstan-grip'; // hand-tracking anchor — kept out of the merge
        capstanGrip = handle;
      }
      anchorCapstan.add(handle);
      for (const sign of [-1, 1]) {
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 8), brassHardwareMat);
        knob.position.set(Math.cos(angle) * sign * 0.72, 0.88, -Math.sin(angle) * sign * 0.72);
        knob.rotation.z = Math.PI * 0.5;
        knob.castShadow = true;
        anchorCapstan.add(knob);
      }
    }

    const anchorChain = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 2.15, 6),
      metalMat,
    );
    anchorChain.position.set(0, -0.78, 0.36);
    anchorChain.castShadow = true;
    anchorCapstan.add(anchorChain);

    group.add(anchorCapstan);

    // Bow anchors: stowed INBOARD, catted against the inner face of the
    // bulwark. The old rule took the greater of the hull surface and the
    // straight 0.44 W bulwark line and then added clearance, which on a galleon
    // hung 616 of 616 iron vertices 1.27 m off the ship's side (ships-04).
    // Arms run fore-aft (y-rotated 90°) so the flukes lie flat along the planking.
    const anchorZ = L * 0.38;
    const anchorX = Math.max(W * 0.12, sheerHalfWidthAt(profile, anchorZ) - 0.42);
    const anchor = new THREE.Group();
    const buildAnchor = (side: -1 | 1) => {
      const g = new THREE.Group();
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 1.65, 6), metalMat);
      shank.castShadow = true;
      g.add(shank);

      const stock = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6), metalMat);
      stock.rotation.z = Math.PI * 0.5;
      stock.position.y = 0.58;
      g.add(stock);

      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 6, 12), metalMat);
      ring.position.y = 0.88;
      ring.rotation.x = Math.PI * 0.5;
      g.add(ring);

      for (const armSide of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.84, 6), metalMat);
        arm.position.set(armSide * 0.18, -0.32, 0);
        arm.rotation.z = armSide * Math.PI * 0.36;
        g.add(arm);

        const fluke = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), metalMat);
        fluke.position.set(armSide * 0.34, -0.73, 0);
        fluke.rotation.z = armSide * Math.PI * 0.14 - Math.PI * 0.18;
        g.add(fluke);
      }

      g.position.set(side * anchorX, 0, anchorZ);
      g.rotation.y = side * Math.PI * 0.5;
      return g;
    };
    anchor.add(buildAnchor(-1));
    anchor.add(buildAnchor(1));
    anchor.position.y = H + 0.34;
    group.add(anchor);

    // Cat beam + chain per side: the stowed anchor HANGS from the ship instead
    // of floating beside it. Static dressing — the anchor group alone descends
    // on drop, paying out visually below the beam.
    for (const side of [-1, 1] as const) {
      const beamInnerX = Math.max(W * 0.06, anchorX - 0.62);
      const beamOuterX = anchorX + 0.16;
      const catBeam = new THREE.Mesh(
        new THREE.BoxGeometry(beamOuterX - beamInnerX, 0.14, 0.15),
        darkMat,
      );
      catBeam.position.set(side * (beamInnerX + beamOuterX) * 0.5, H + 1.1, anchorZ);
      catBeam.castShadow = true;
      group.add(catBeam);
      // Knee bracing the beam down onto the cap-rail line
      const knee = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.13), darkMat);
      knee.position.set(side * (W * 0.44), H + 0.73, anchorZ);
      knee.castShadow = true;
      group.add(knee);
      // Chain: anchor ring (raised pose, y=H+1.22) → over the beam → capstan drum
      const ringPt = new THREE.Vector3(side * anchorX, H + 1.2, anchorZ);
      const beamPt = new THREE.Vector3(side * (W * 0.44 - 0.35), H + 1.06, anchorZ + 0.05);
      const drumPt = new THREE.Vector3(side * 0.3, H + 0.78, L * 0.415);
      group.add(makeCylinderBetween(ringPt, beamPt, 0.03, metalMat, 6));
      group.add(makeCylinderBetween(beamPt, drumPt, 0.03, metalMat, 6));
    }

    // Rope coil flaked down beside the anchor capstan
    const ropeCoil = makeRopeCoil(ropeCoilMat, 0.3, 0.062, 3, 2.7, this.lodPhone ? 4 : 6);
    ropeCoil.position.set(-0.24, H + 0.1, L * 0.38);
    ropeCoil.rotation.y = 0.6;
    group.add(ropeCoil);

    // ── Masts, yards, sails, crow's nest + ladder, rope stations, jib and the
    // instanced rigging: built by ship/sails.ts buildRig (b4.2a), same order.
    const { sails, furledSails, pennants, trimPivots, nestFloorMesh, mastStartZ, ropeRig, rigSet } = buildRig({
      group, ship, stats, profile, H, L, W, darkMat, deckMat, sailMat, upgradeVisuals,
      quality: this.quality,
      phone: this.lodPhone,
      darkWoodTex: this.darkWoodTex,
      teamSailTexture: (teamColor) => this.getTeamSailTexture(teamColor),
      addSwiftSailTrim: (sail, w, h, targets, staySail) => this.addSwiftSailTrim(sail, w, h, targets, staySail),
    });

    // ── Cannons ──────────────────────────────────────────────
    const cannonGroups: CannonMeshGroup[] = [];
    const cannonCount = stats.cannonCount;
    const cannonsPerSide = cannonCount / 2;

    // Bigger, more visibly detailed cannons. Material highlights:
    // - Dark iron barrel with three brass reinforcing bands
    // - Brass muzzle bell at the front so the gun reads clearly even from far
    // - Beefier oak carriage with iron-banded wheels and trunnion caps
    const brassMat = this.sharedMat('brass-fitting', { color: 0xb48335, roughness: 0.45, metalness: 0.7 });
    const ironMat = this.sharedMat('iron', { color: 0x1c1c20, roughness: 0.55, metalness: 0.55 });
    const oakMat = this.sharedMat('oak', { color: 0x4f3520, roughness: 0.95 });
    const wheelMat = this.sharedMat('wheel', { color: 0x261810, roughness: 0.95 });
    const ironBandMat = this.sharedMat('iron-band', { color: 0x3a3a40, roughness: 0.5, metalness: 0.7 });
    const boreMat = new THREE.MeshBasicMaterial({ color: 0x040404 });
    const lashingMat = this.sharedMat('lashing', { color: 0xc8b27a, roughness: 1 });
    const chargedMetalMat = new THREE.MeshStandardMaterial({
      color: UPGRADE_PENNANT_COLORS.charged_cannons,
      emissive: 0xff3200,
      emissiveIntensity: 1.15,
      roughness: 0.3,
      metalness: 0.62,
    });
    const chargedGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff6c22,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // Phones (D26 own-hull cap 45k): the guns at about half the facets
    // (barrels 8 sides, not 14; trucks, bands and knobs likewise).
    const ph = this.lodPhone;
    const cannonSeg = ph ? 8 : 14;
    const barrelLen = 1.5;
    const barrelR = 0.18;
    for (let side = 0; side < 2; side++) {
      const sideX = (side === 0 ? 1 : -1) * (W * 0.5 + 0.06);
      for (let c = 0; c < cannonsPerSide; c++) {
        // Row z comes from the SHARED stand-point math so the visual gun, the
        // [X] prompt zone and the mount snap always agree (the sloop's single
        // gun per side sits amidships now, not up in the anchor/mast band).
        const cz = getCannonDeckLocalPosition(stats, side === 0 ? c : cannonsPerSide + c).z;
        const cg = new THREE.Group();
        const yawPivot = new THREE.Group();
        const pitchPivot = new THREE.Group();
        cg.add(yawPivot);
        yawPivot.add(pitchPivot);
        pitchPivot.position.set(0, 0.18, 0);

        // Main barrel — taper from breech (back) to muzzle (front)
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.95, barrelR * 1.2, barrelLen, cannonSeg),
          ironMat,
        );
        barrel.rotation.z = Math.PI * 0.5;
        barrel.position.x = barrelLen * 0.5 - 0.1;
        barrel.castShadow = true;
        pitchPivot.add(barrel);

        // Brass reinforcing bands at three positions along the barrel
        for (const offset of [0.05, 0.55, 0.95] as const) {
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.2, barrelR * 1.25, 0.08, cannonSeg),
            brassMat,
          );
          band.rotation.z = Math.PI * 0.5;
          band.position.x = -0.1 + offset * barrelLen;
          pitchPivot.add(band);
        }

        // Brass muzzle bell — flared at the front so the gun reads clearly
        const muzzle = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 1.45, barrelR * 1.0, 0.18, cannonSeg),
          brassMat,
        );
        muzzle.rotation.z = Math.PI * 0.5;
        muzzle.position.x = barrelLen - 0.1 + 0.06;
        muzzle.castShadow = true;
        pitchPivot.add(muzzle);

        // Dark muzzle bore (interior)
        const bore = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.65, barrelR * 0.65, 0.06, ph ? 8 : 12),
          boreMat,
        );
        bore.rotation.z = Math.PI * 0.5;
        bore.position.x = barrelLen - 0.1 + 0.13;
        pitchPivot.add(bore);

        const chargeGroup = new THREE.Group();
        chargeGroup.name = 'upgrade-charged-cannon';
        chargeGroup.visible = false;
        for (const offset of [0.26, 0.7, 1.05] as const) {
          const chargeBand = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.34, barrelR * 1.38, 0.035, cannonSeg),
            chargedMetalMat,
          );
          chargeBand.rotation.z = Math.PI * 0.5;
          chargeBand.position.x = -0.1 + offset * barrelLen;
          chargeGroup.add(chargeBand);
        }
        const muzzleGlow = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.72, ph ? 6 : 10, ph ? 5 : 8),
          chargedGlowMat,
        );
        muzzleGlow.position.x = barrelLen - 0.1 + 0.2;
        muzzleGlow.scale.set(1.35, 0.72, 0.72);
        chargeGroup.add(muzzleGlow);
        pitchPivot.add(chargeGroup);
        upgradeVisuals.charged_cannons.push(chargeGroup);

        // Cascabel (round knob at the back of the breech)
        const cascabel = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.6, ph ? 6 : 10, ph ? 5 : 8),
          ironMat,
        );
        cascabel.position.x = -0.18;
        pitchPivot.add(cascabel);

        // Touch hole on top of the breech
        const touchHole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.04, 0.08, ph ? 6 : 8),
          ironMat,
        );
        touchHole.position.set(0.06, barrelR * 1.0, 0);
        pitchPivot.add(touchHole);

        // Trunnion caps (the bumps that let the barrel pivot)
        for (const sz of [-1, 1] as const) {
          const trunnion = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 0.45, barrelR * 0.45, 0.16, ph ? 6 : 10),
            ironMat,
          );
          trunnion.rotation.x = Math.PI * 0.5;
          trunnion.position.set(0.42, 0, sz * (barrelR * 1.25));
          pitchPivot.add(trunnion);
        }

        // Cannon mount (wheeled oak carriage)
        const mount = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 0.32, 0.55),
          oakMat,
        );
        mount.position.set(0.18, 0.0, 0);
        mount.castShadow = true;
        cg.add(mount);

        // Diagonal step planks on the carriage cheeks
        for (const sz of [-1, 1] as const) {
          const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.06), oakMat);
          cheek.position.set(0.18, 0.05, sz * 0.305);
          cheek.castShadow = true;
          cg.add(cheek);
        }

        // Carriage wheels — slightly larger
        for (const wz of [-0.27, 0.27] as const) {
          for (const wx of [-0.18, 0.42] as const) {
            const wheel = new THREE.Mesh(
              new THREE.CylinderGeometry(0.18, 0.18, 0.08, ph ? 8 : 12),
              wheelMat,
            );
            wheel.rotation.x = Math.PI * 0.5;
            wheel.position.set(wx, -0.18, wz);
            wheel.castShadow = true;
            cg.add(wheel);
            // Iron rim
            const rim = new THREE.Mesh(
              new THREE.TorusGeometry(0.18, 0.022, ph ? 4 : 6, ph ? 8 : 16),
              ironBandMat,
            );
            rim.rotation.x = Math.PI * 0.5;
            rim.position.set(wx, -0.18, wz);
            cg.add(rim);
          }
        }

        // Lashing rope on the back of the carriage (visual flair)
        const lashing = new THREE.Mesh(
          new THREE.TorusGeometry(0.1, 0.025, ph ? 4 : 6, ph ? 8 : 12),
          lashingMat,
        );
        lashing.rotation.y = Math.PI * 0.5;
        lashing.position.set(-0.16, 0.05, 0);
        cg.add(lashing);

        // b4.3c: the gunport frame + hinged lid are the kit's, on spline
        // sockets over each gun (ship/kit.ts shipKitSockets).

        // Merge rigid geometry per pivot: barrel hardware bakes into ~2 meshes
        // that still swing with the pitch pivot, carriage into a few under root.
        // perf-15: a gun is a gun. Every carriage of a class merges to the
        // same local geometry, so the whole broadside shares one set of buffers.
        mergeStaticMeshes(chargeGroup, NO_MERGE_EXCLUDE, `cannon-charge-${ship.type}${ph ? '-phone' : ''}`);
        mergeStaticMeshes(pitchPivot, new Set<THREE.Object3D>([chargeGroup]), `cannon-pitch-${ship.type}${ph ? '-phone' : ''}`);
        mergeStaticMeshes(cg, new Set<THREE.Object3D>([yawPivot]), `cannon-root-${ship.type}${ph ? '-phone' : ''}`);

        cg.position.set(sideX, H + 0.18, cz);
        cg.rotation.y = side === 0 ? 0 : Math.PI;
        group.add(cg);
        // b3.3c: breech handle grips for the gunner's hand IK (behind the cascabel).
        pitchPivot.userData[IK_GRIPS_KEY] = { kind: 'cannon', points: [new THREE.Vector3(-0.28, 0.1, 0.2), new THREE.Vector3(-0.28, 0.1, -0.2)] };
        cannonGroups.push({ root: cg, yawPivot, pitchPivot });
      }
    }

    // ── Barrels on Deck ──────────────────────────────────────
    // Three FUNCTIONAL supply barrels (SoT read): FOOD / PLANK / CANNONBALL,
    // named + tagged so the client can hang interactions off them, plus 1-2
    // unlabeled decor barrels. Every spot is validated against the deck work
    // stations so no hull class lands a barrel inside a walk/work zone.
    const mainMastLocalZ = getMainMastLocalZ(stats);
    const deckStations: Array<{ x: number; z: number; r: number }> = [
      { x: 0, z: L * 0.42, r: 1.25 },     // anchor capstan (handles sweep 0.71)
      { x: 0, z: -L * 0.315, r: 1.4 },    // helm wheel
      ...getSailRopeStationLocals(stats).map((s) => ({ x: s.x, z: s.z, r: 1.3 })),
      ...getBraceStationLocals(stats).map((s) => ({ x: s.x, z: s.z, r: 1.3 })),
    ];
    for (let ci = 0; ci < cannonCount; ci++) {
      const spot = getCannonDeckLocalPosition(stats, ci);
      deckStations.push({ x: spot.x, z: spot.z, r: 1.2 });
    }
    const clearOfStations = (x: number, z: number): boolean => {
      // Companionway stair lip: keep the run-up in front of the stairs free.
      if (Math.abs(z - companionway.stairFrontZ) < 1.2
        && Math.abs(x - companionway.cx) < companionway.stairHalfWidth + 0.7) return false;
      // The open stairwell itself — a barrel there floats over the hole.
      if (Math.abs(x - companionway.cx) < companionway.halfX + 0.45
        && Math.abs(z - companionway.cz) < companionway.halfZ + 0.45) return false;
      return deckStations.every((s) => (x - s.x) ** 2 + (z - s.z) ** 2 >= s.r * s.r);
    };
    const pickSpot = (candidates: Array<[number, number]>): [number, number] => {
      for (const c of candidates) if (clearOfStations(c[0], c[1])) return c;
      return candidates[candidates.length - 1]; // last candidate clears on every hull class
    };

    const barrelHoopMat = this.sharedMat('hoop', { color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });
    const supplyBarrels: THREE.Group[] = [];
    const addSupplyBarrel = (kind: SupplyKind, x: number, z: number) => {
      const lidMat = this.sharedMat(`supply-lid-${kind}`, { map: supplyLidTexture(kind), roughness: 0.78 });
      const barrel = makeBarrel(barrelWoodMat, barrelHoopMat, lidMat);
      barrel.name = `supply-barrel-${kind}`;
      barrel.userData.supplyKind = kind;
      barrel.position.set(x, H + 0.5, z);
      // Deterministic yaw from the barrel's own berth, the same way the decor
      // barrels were fixed in slice b, and for a second reason on top of that
      // one. `Math.random()` here reads the GLOBAL sequence, and three draws
      // from that same sequence for every generateUUID — so adding one mesh
      // anywhere else in the renderer silently re-rolled every supply barrel on
      // every hull, and test-ship-geometry-hash's ship-barrel-wood family
      // re-pinned on changes that had nothing to do with barrels. (That is
      // exactly how this was found: two lanterns in the hold moved the barrels.)
      // Supply barrels are NO_MERGE_EXCLUDE so this never corrupted the shared
      // bake the way the decor barrels did, but it was the same landmine.
      barrel.rotation.y = (Math.abs(Math.sin(x * 12.9898 + z * 78.233)) % 1) * Math.PI * 2;
      // Bake the barrel's own staves/hoops, but keep the named group intact
      // (it's excluded from the ship-level merge below).
      // A barrel is a barrel on every hull in the game — one set of staves.
      mergeStaticMeshes(barrel, NO_MERGE_EXCLUDE, 'supply-barrel');
      group.add(barrel);
      supplyBarrels.push(barrel);
    };
    // FOOD: at the mainmast base, forward-port of the mast (the rope stations
    // sit abeam it and the companionway opens aft-starboard).
    const foodSpot = pickSpot([
      [-W * 0.16, mainMastLocalZ + 1.35],
      [-W * 0.24, mainMastLocalZ + 1.7],
    ]);
    addSupplyBarrel('food', foodSpot[0], foodSpot[1]);
    // PLANK: on the main deck just forward of the quarterdeck front step.
    const plankSpot = pickSpot([
      [-W * 0.28, qd.frontZ + 1.7],
      [W * 0.28, qd.frontZ + 1.7],
    ]);
    addSupplyBarrel('plank', plankSpot[0], plankSpot[1]);
    // CANNONBALL: one per side between the broadside cannons. Same z both
    // sides — first candidate that clears the cannon spots AND the stairwell
    // (the galleon has a gun at z≈L*0.033; the sloop's stairwell owns z≈0).
    const shotX = W * 0.5 - 1.3;
    const shotZ = ([L * 0.02, -L * 0.05, -L * 0.12].find(
      (z) => clearOfStations(shotX, z) && clearOfStations(-shotX, z),
    ) ?? -L * 0.12);
    for (const side of [-1, 1] as const) {
      addSupplyBarrel('shot', side * shotX, shotZ);
    }

    // ── Ammo chest (SoT): centreline aft of the companionway — [X] refills
    // every firearm. The spot comes from shared getAmmoCrateLocal so the
    // prompt zone and the visible crate can never drift apart.
    {
      const crateSpot = getAmmoCrateLocal(stats);
      const crate = new THREE.Group();
      crate.name = 'ammo-crate';
      const crateOak = this.sharedMat('crate-oak', { color: 0x453019, roughness: 0.9 });
      const crateIron = this.sharedMat('crate-iron', { color: 0x23232a, roughness: 0.5, metalness: 0.65 });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.5, 0.62), crateOak);
      body.position.y = 0.25;
      body.castShadow = true;
      crate.add(body);
      for (const bx of [-0.34, 0.34]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.52, 0.65), crateIron);
        band.position.set(bx, 0.25, 0);
        crate.add(band);
      }
      // Lid propped open against the aft face, balls visible inside.
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.05, 0.62), crateOak);
      lid.position.set(0, 0.62, -0.36);
      lid.rotation.x = -Math.PI * 0.42;
      crate.add(lid);
      const ballMat = this.sharedMat('crate-ball', { color: 0x14141a, roughness: 0.35, metalness: 0.6 });
      for (const [bx, bz] of [[-0.2, 0.08], [0.05, -0.1], [0.26, 0.1], [0.02, 0.14]] as const) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), ballMat);
        ball.position.set(bx, 0.52, bz);
        crate.add(ball);
      }
      const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 0.3, 8), crateIron);
      horn.position.set(-0.32, 0.56, -0.18);
      horn.rotation.z = Math.PI * 0.4;
      crate.add(horn);
      mergeStaticMeshes(crate, NO_MERGE_EXCLUDE, 'hold-crate');
      crate.position.set(crateSpot.x, H + 0.1, crateSpot.z);
      group.add(crate);
      deckStations.push({ x: crateSpot.x, z: crateSpot.z, r: 1.15 });
    }

    // Decor barrels (unlabeled, merge into the static bake): a water barrel at
    // the port rail amidships; a rum barrel forward-starboard on bigger hulls.
    const decorSpots: Array<{ x: number; z: number; lid: number }> = [];
    const waterSpot = pickSpot([[-W * 0.31, L * 0.02], [-W * 0.31, -L * 0.06]]);
    decorSpots.push({ x: waterSpot[0], z: waterSpot[1], lid: 0x3a6ab0 });
    if (ship.type !== 'sloop') {
      const rumSpot = pickSpot([[W * 0.36, mainMastLocalZ + 1.5], [W * 0.3, mainMastLocalZ + 1.9]]);
      decorSpots.push({ x: rumSpot[0], z: rumSpot[1], lid: 0x6a2808 });
    }
    // b4.3c: decor barrels are the kit's staved barrel (ship_kit_b) on the
    // deck slab; deterministic yaw from the berth (perf-15, see above).
    const kitDeckSpots: Array<{ x: number; z: number; yaw: number; part?: DeckKitPart }> = decorSpots.map((spot) => ({
      x: spot.x, z: spot.z, yaw: (Math.abs(Math.sin(spot.x * 12.9898 + spot.z * 78.233)) % 1) * Math.PI * 2,
    }));
    // b4.3c: kit II deck hardware (ship's bell, elm-tree bilge pump, shot
    // garlands) on main-deck berths clear of every work station, the masts,
    // the stairwell and each other; a part with no clear berth stays off.
    {
      const taken: Array<{ x: number; z: number; r: number }> = [
        ...getShipRigPlan(stats).map((mp) => ({ x: 0, z: mp.z, r: 0.95 })),
        ...supplyBarrels.map((b) => ({ x: b.position.x, z: b.position.z, r: 0.85 })),
        ...decorSpots.map((d) => ({ x: d.x, z: d.z, r: 0.85 })),
      ];
      // Sweep the main deck (quarterdeck front to the bow capstan band) on a
      // 25 cm grid and take the clear berth nearest the part's preferred spot.
      const half = (z: number) => sheerHalfWidthAt(profile, z);
      const berth = (part: DeckKitPart, r: number, pref: [number, number], yawAt: (x: number) => number, rail = 0): void => {
        const along = part === 'cannonball_rack'; // a 1.1 m garland, long axis fore-aft
        const cands: Array<[number, number]> = [];
        for (let z = qd.frontZ + r + 0.5; z <= L * 0.32; z += 0.25) {
          if (rail) { cands.push([rail * (half(z) - 0.6), z]); continue; }
          for (let x = -half(z) + 0.35 + r; x <= half(z) - 0.35 - r; x += 0.25) cands.push([x, z]);
        }
        cands.sort((p, q) => Math.hypot(p[0] - pref[0], p[1] - pref[1]) - Math.hypot(q[0] - pref[0], q[1] - pref[1]));
        const rr = along ? 0.3 : r;
        for (const [x, z] of cands) {
          const ends: Array<[number, number]> = along ? [[x, z - 0.55], [x, z], [x, z + 0.55]] : [[x, z]];
          if (!ends.every(([ex, ez]) => clearOfStations(ex, ez) && taken.every((t) => (ex - t.x) ** 2 + (ez - t.z) ** 2 >= (t.r + rr) ** 2))) continue;
          kitDeckSpots.push({ x, z, yaw: yawAt(x), part });
          taken.push(...ends.map(([ex, ez]) => ({ x: ex, z: ez, r: rr })));
          return;
        }
      };
      // Bell on the centreline forward of the mainmast, pump abaft it (the
      // brake handle athwartships), a shot garland against each bulwark by
      // the shot barrels.
      berth('bell', 0.6, [0, mainMastLocalZ + 1.7], () => 0);
      berth('bilge_pump', 0.5, [W * 0.15, mainMastLocalZ - 1.2], (x) => (x >= 0 ? -1 : 1) * Math.PI / 2);
      for (const side of [-1, 1] as const) berth('cannonball_rack', 0.6, [side * W * 0.5, shotZ], () => -side * Math.PI / 2, side);
    }

    // Mooring line flaked down near the stern quarter
    const sternRope = makeRopeCoil(ropeCoilMat, 0.24, 0.052, 7, 2.9, this.lodPhone ? 4 : 6);
    sternRope.position.set(W * 0.3, H + 0.1, -L * 0.26);
    sternRope.rotation.y = -1.1;
    group.add(sternRope);

    // ── Lanterns ─────────────────────────────────────────────
    // Warm amber glass (matches the GLB Lantern_Glass palette). ONE shared glass
    // material per ship so every fixture merges into a single controllable mesh
    // whose emissive ramps day→night via setNightFactor().
    const lanternGlassMat = new THREE.MeshStandardMaterial({
      color: 0xffcf87,
      emissive: 0xff9a34,
      emissiveIntensity: 0.15,
      roughness: 0.32,
      metalness: 0.1,
    });
    const lanternGlassMats = [lanternGlassMat];

    const sternLanternPos = new THREE.Vector3(0, H + 0.9, -L * 0.46);
    const lanternMounts: THREE.Vector3[] = [sternLanternPos.clone()];
    if (ship.type === 'sloop') {
      // Mast lantern lashed to the single mast
      lanternMounts.push(new THREE.Vector3(0.16, H + 2.15, mastStartZ + 0.12));
    } else if (ship.type === 'galleon') {
      // Extra lantern by the helm
      lanternMounts.push(new THREE.Vector3(W * 0.22, H + 1.5, -L * 0.3));
    }
    // b3.4e: GLB lanterns when the library already has the hardware (they stay
    // out of the static merge so the far sibling can swap); otherwise the
    // procedural fixture merges into the hull as before.
    const hwLanterns: HardwarePart[] = [];
    const lanternHolders: THREE.Object3D[] = [];
    for (const mount of lanternMounts) {
      const glb = this.hardwareReady() ? this.lanternFromGlb(lanternGlassMat) : null;
      if (glb) {
        // The GLB hangs from its hook at y = 0; the procedural hook top is at +0.3.
        glb.holder.position.copy(mount).add(new THREE.Vector3(0, 0.3, 0));
        group.add(glb.holder);
        lanternHolders.push(glb.holder);
        hwLanterns.push(glb.part);
        continue;
      }
      const fixture = makeLanternFixture(lanternGlassMat, metalMat);
      fixture.position.copy(mount);
      group.add(fixture);
    }

    // ONE warm PointLight per ship. Off by day; at night only the nearest
    // handful of ships light it (see update()).
    //
    // Reach and falloff are set so it actually lights the DECK YOU STAND ON: at
    // 9m from the stern with decay 1.6 it died before midships, so a night watch
    // was a black stage with a floating '[X] Take Helm' prompt on it. 21m of
    // gentler falloff washes the whole planking of every hull class, which is
    // what the lantern pool is for.
    const nightLight = new THREE.PointLight(0xffb060, 0, 21, 1.25);
    nightLight.position.copy(sternLanternPos);
    nightLight.visible = false;
    registerBudgetLight(nightLight);
    group.add(nightLight);
    const lanterns: THREE.PointLight[] = [nightLight];

    // ── Flag ─────────────────────────────────────────────────
    // The colours here ARE the team identity at range, so the flag gets its own
    // pivot (yawed to the wind each frame) and a mesh held OUT of the static hull
    // merge. Merged in, it was a rigid painted board nailed to the masthead of a
    // ship that pitches and rolls under it.
    // Height: on a staff at the TRUCK, above the mast cap. It used to sit at
    // H + height*3, which on every hull is inside the crow's-nest basket — the
    // cloth passed straight through the floor and staves. Above the cap it is
    // clear of the nest, clear of the masthead pennant, and readable at range.
    const mainMastH = getMastHeight(stats);
    const mastCapY = H + mainMastH;
    const ensignStaff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.042, 0.9, 6),
      darkMat,
    );
    ensignStaff.position.set(0, mastCapY + 0.45, mastStartZ);
    group.add(ensignStaff);

    const flagPivot = new THREE.Group();
    flagPivot.position.set(0, mastCapY + 0.52, mastStartZ);
    group.add(flagPivot);
    const flagUniforms: FlagUniforms = {
      uFlagTime: { value: 0 },
      uFlagWave: { value: new THREE.Vector2(0.02, flagPhaseFromId(ship.id)) },
    };
    const flag: ShipFlag = { pivot: flagPivot, uniforms: flagUniforms };

    // Cloth: segmented along the fly so the vertex wave has something to bend,
    // with the hoist at local x = 0 (the halyard the shader pins). The jolly
    // roger is PAINTED into the per-team texture rather than built from little
    // spheres and boxes — the blazon then deforms with the cloth for free, and
    // the whole flag stays ONE draw call instead of three.
    const flagGeo = new THREE.PlaneGeometry(FLAG_FLY, FLAG_DROP, 14, 4);
    flagGeo.translate(FLAG_FLY * 0.5 + 0.06, 0, 0);
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: flagTexture(ship.teamColor),
      emissive: ship.teamColor,
      emissiveIntensity: 0.22,
      side: THREE.DoubleSide,
      roughness: 0.8,
    });
    applyFlagWave(flagMat, flagUniforms);
    flagPivot.add(new THREE.Mesh(flagGeo, flagMat));

    // ── Owner's swallowtail ──────────────────────────────────
    // Flown above the ensign on the LOCAL crew's hull only (see ownPennant in
    // ShipMeshGroup). Same halyard pivot as the ensign, so it streams with the
    // same wind; unlit gold so it holds its colour at dusk and at night, when
    // "which of these silhouettes is mine" is hardest. Hidden by default —
    // update() hoists it on the one ship the local player crews.
    const ownPennantGeo = new THREE.PlaneGeometry(FLAG_FLY * 0.72, FLAG_DROP * 0.34, 10, 2);
    ownPennantGeo.translate(FLAG_FLY * 0.36 + 0.06, 0, 0);
    const ownPennant = new THREE.Mesh(
      ownPennantGeo,
      new THREE.MeshBasicMaterial({
        color: 0xf2ce6a,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
        toneMapped: false,
        depthWrite: false,
      }),
    );
    applyFlagWave(ownPennant.material as THREE.Material, flagUniforms);
    ownPennant.position.y = FLAG_DROP * 0.62 + 0.16;
    ownPennant.renderOrder = 3;
    ownPennant.visible = false;
    ownPennant.name = 'own-pennant';
    flagPivot.add(ownPennant);

    const upgradePennants = {
      hull_reinforcement: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.hull_reinforcement,
          emissive: UPGRADE_PENNANT_COLORS.hull_reinforcement,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      charged_cannons: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissive: UPGRADE_PENNANT_COLORS.charged_cannons,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      swift_sails: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.swift_sails,
          emissive: UPGRADE_PENNANT_COLORS.swift_sails,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
      lightning_rod: new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.18),
        new THREE.MeshStandardMaterial({
          color: UPGRADE_PENNANT_COLORS.lightning_rod,
          emissive: UPGRADE_PENNANT_COLORS.lightning_rod,
          emissiveIntensity: 0.18,
          roughness: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
    } satisfies Record<ShipUpgradeType, THREE.Mesh>;
    // Upgrade pennants keep their long-standing spot on the mast, well below the
    // nest (the team flag moved to the truck; these did not).
    const upgradePennantY = H + stats.height * 3;
    const upgradePennantEntries = [
      { type: 'hull_reinforcement' as const, x: 0.34, y: upgradePennantY - 0.72, z: mastStartZ + 0.12 },
      { type: 'charged_cannons' as const, x: 0.34, y: upgradePennantY - 0.98, z: mastStartZ + 0.02 },
      { type: 'swift_sails' as const, x: 0.34, y: upgradePennantY - 1.24, z: mastStartZ - 0.08 },
      { type: 'lightning_rod' as const, x: 0.34, y: upgradePennantY - 1.50, z: mastStartZ - 0.18 },
    ];
    for (const { type, x, y, z } of upgradePennantEntries) {
      const pennant = upgradePennants[type];
      pennant.position.set(x, y, z);
      pennant.visible = false;
      group.add(pennant);
    }

    // Bake all static dressing into one mesh per material — this is where the
    // per-ship draw-call count collapses. Everything animated, tinted or
    // visibility-toggled at runtime is excluded and keeps its own object.
    mergeStaticMeshes(wheelGroup, NO_MERGE_EXCLUDE, `wheel-${ship.type}`);
    mergeStaticMeshes(anchor, NO_MERGE_EXCLUDE, `anchor-${ship.type}`);
    mergeStaticMeshes(anchorCapstan, new Set<THREE.Object3D>(
      capstanGrip ? [anchorChain, capstanGrip] : [anchorChain],
    ), `capstan-${ship.type}`);
    const mergeExclude = new Set<THREE.Object3D>([
      holdCargo.group,
      ...sails,
      ...furledSails,
      ...pennants,
      ...trimPivots,
      ...Object.values(upgradePennants),
      ...Object.values(upgradeVisuals).flat(),
      ...supplyBarrels,
      ...cannonGroups.map((cannon) => cannon.root),
      ...(nestFloorMesh ? [nestFloorMesh] : []),
      flagPivot,
      waterlineFoam,
      wheelGroup,
      rudderPivot,
      compassNeedle,
      anchor,
      anchorCapstan,
      holdWater.mesh,
      holdWater.shaft,
      ...lanternHolders,
    ]);
    // perf-15: the static hull is identical across every ship of a class —
    // team colour is a material, breaches a uniform, sails/flags/upgrades/patches
    // are all excluded above — so the merged buffers are shared and refcounted
    // instead of copied per hull. 25.7 MB of ship geometry becomes one set.
    // b2-device-04: materials the hold uses and nothing outside it does. The
    // merge batches by material, so the merged meshes carrying these are pure
    // hold and can be culled without splitting a draw.
    const holdOnlyMats = new Set<THREE.Material>();
    interior.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m)) holdOnlyMats.add(m);
    });
    const dropSharedMats = (o: THREE.Object3D) => {
      if (o === interior) return;
      const m = (o as THREE.Mesh).material;
      if (m) for (const mm of Array.isArray(m) ? m : [m]) holdOnlyMats.delete(mm);
      for (const c of o.children) dropSharedMats(c);
    };
    dropSharedMats(group);
    // A hull whose lanterns are GLBs merges a different static set: its own key.
    // The quality is in the key too (b4.2d): the low tier builds its shell on
    // the LOD1 grid, and a merge cached by a high build would hand a low hull
    // the 72 x 48 shell (galleon low own hull 63k instead of 54k).
    // b4.2d LOD1: baked from the same parts BEFORE the detail merge, so the
    // silhouette at 30-90 m is the detail hull's own. Dynamic parts (sails,
    // yards, flags, upgrades, barrels) stay out as they do of the merge;
    // cannons go in at rest; the hold, the LOD0 shell and anything
    // see-through never do.
    const lod1Skip = new Set<THREE.Object3D>([...mergeExclude, hull, interior, waterlineFoam, holdWater.mesh, holdWater.shaft]);
    for (const c of cannonGroups) lod1Skip.delete(c.root);
    const lod1Accept = (m: THREE.Mesh): THREE.Color | null => {
      for (let o: THREE.Object3D | null = m; o && o !== group; o = o.parent) if (lod1Skip.has(o)) return null;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (!mat.color || mat.transparent || mat.blending !== THREE.NormalBlending) return null;
      const tone = mat.color.clone();
      if (mat.map && tone.r > 0.9 && tone.g > 0.9 && tone.b > 0.9) tone.set(LOD1_TEXTURED_TONE[mat.name] ?? LOD1_TEXTURED_TONE.default);
      return tone;
    };
    const lodKeySuffix = `${this.quality}${this.lodPhone ? '-phone' : ''}${hwLanterns.length ? '-hwlantern' : ''}`;
    const lod1 = this.buildShipLod1(ship, stats, group, lod1Accept, `${shipLodKey(ship.type, 1)}-${lodKeySuffix}`);
    mergeStaticMeshes(group, mergeExclude, `detail-${ship.type}-${lodKeySuffix}`);

    // ── Wake foam ─────────────────────────────────────────────
    // Scene-level (NOT parented to the ship): the old wake quad inherited hull
    // pitch/roll/sinking rotation and reared out of the water as a giant tilted
    // white rectangle. This one follows the Gerstner surface in world space.
    const wake = this.createShipWake();
    this.scene.add(wake.group);

    const detailRoot = new THREE.Group();
    detailRoot.name = 'ship-detail-root';
    while (group.children.length > 0) {
      detailRoot.add(group.children[0]);
    }
    group.add(detailRoot);
    // b4.2h: the rigging is drawn past the detail band (ratlines to 60 m,
    // running rigging to 150 m, a card per mast past 250 m), so it lives in
    // its own root beside the level roots, not inside the LOD0 detail root.
    const rigRoot = new THREE.Group();
    rigRoot.name = 'ship-rig-root';
    if (rigSet) rigRoot.add(rigSet.rope.mesh, rigSet.ratline.mesh, rigSet.far);
    group.add(rigRoot);

    const proxyRoot = this.buildShipFar(ship, stats);
    proxyRoot.visible = false;
    group.add(proxyRoot);
    lod1.group.visible = false;
    group.add(lod1.group);
    const lod2 = this.buildShipLod2(ship, stats);
    lod2.group.visible = false;
    group.add(lod2.group);

    group.position.set(ship.position.x, ship.position.y, ship.position.z);
    group.rotation.y = ship.rotation;
    this.scene.add(group);

    this.shipMeshes.set(ship.id, {
      root: group,
      detailRoot,
      proxyRoot,
      proxySails,
      lod1Root: lod1.group,
      lod1Sails: lod1.sails,
      lod2Root: lod2.group,
      lod2Sails: lod2.sails,
      lod2SailAngle: ship.sailAngle,
      lod2SailScale: Math.max(0.18, ship.sailHeight),
      lodLevel: 0,
      sails,
      furledSails,
      pennants,
      flag,
      upgradePennants,
      upgradeVisuals,
      fireParticles: null,
      hullProfile: profile,
      holeVis: new Map<number, HoleVis>(),
      trimPivots,
      rigging: ropeRig,
      rigSet,
      cannonMeshes: cannonGroups,
      lanterns,
      wheel: wheelGroup,
      rudderPivot,
      compassNeedle,
      anchor,
      anchorChain,
      anchorCapstan,
      hardware: null,
      kit: null,
      kitSockets: [...shipKitSockets(ship.type), ...deckKitSockets(ship.type, kitDeckSpots)],
      wheelRimR: rimR,
      lanternGlassMats,
      nightLight,
      holdWater,
      holdCargoTiers: holdCargo.tiers,
      holdInterior: [
        holdCargo.group,
        ...(() => {
          const out: THREE.Object3D[] = [];
          detailRoot.traverse((o) => {
            const m = (o as THREE.Mesh).material;
            if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && holdOnlyMats.has(m)) out.push(o);
          });
          return out;
        })(),
      ],
      holdInteriorShown: true,
      wake,
      hullHoleUniform,
      hullHoleEnds,
      holdHalfAt: (z: number) => holdHalfWidthAt(stats, profile, z),
      bilgeFaceAt: (side: -1 | 1, y: number) => bilgeBoardInboardFaceAt(stats, profile, side, y),
      ceilingAt: (z: number, y: number) => holdCeilingHalfAt(profile, z, y),
      lockerTop: holdLockerTopY(stats),
      holdHalfLen: stats.length * HOLD_HALF_LENGTH_F,
      waterlineFoam,
      plankUniforms,
      ownPennant,
    });
    const built = this.shipMeshes.get(ship.id)!;
    if (this.hardwareReady()) this.mountHardware(built, hwLanterns);

    return group;
  }

  /** All four hardware files are loaded (far siblings are optional). */
  private hardwareReady(): boolean {
    const src = this.hardwareSource;
    return !!src && SHIP_HARDWARE.every((n) => src.has(n));
  }

  private hardwareClone(name: ShipHardwareName, far: boolean): THREE.Group | null {
    const src = this.hardwareSource;
    const g = src ? (far ? src.cloneFar(name) : src.clone(name)) : null;
    if (!g) return null;
    g.traverse((o) => {
      o.userData[HW_SHARED] = true; // library-owned geometry: clear() must not dispose it
      if ((o as THREE.Mesh).isMesh) { o.castShadow = !far; o.receiveShadow = true; }
    });
    return g;
  }

  private hardwareMeshes(name: ShipHardwareName, far: boolean): number {
    const key = far ? `${name}_far` : name;
    let n = this.hardwareMeshCount.get(key);
    if (n === undefined) {
      const src = this.hardwareSource;
      const g = src ? (far ? src.cloneFar(name) : src.clone(name)) : null;
      n = 0;
      g?.traverse((o) => { if ((o as THREE.Mesh).isMesh) n! += 1; });
      if (far && !g) n = this.hardwareMeshes(name, false); // no far sibling: the near file stays up
      this.hardwareMeshCount.set(key, n);
    }
    return n;
  }

  /** Meshes a late mount makes visible on this hull at this distance. */
  private hardwareMountCost(mesh: ShipMeshGroup, distSq: number): number {
    const swap = farSwapDistance(this.quality);
    const far = this.quality === 'low' || distSq > swap * swap;
    return mesh.cannonMeshes.length * this.hardwareMeshes('cannon', far)
      + this.hardwareMeshes('wheel', far) + this.hardwareMeshes('capstan', far);
  }

  /** Grip anchors for a spoked file (wheel handles, capstan bars), in GLB units. */
  private tipsOf(name: 'wheel' | 'capstan', node: THREE.Object3D, plane: 'xy' | 'xz'): THREE.Vector3[] {
    let tips = this.hardwareTips.get(name);
    if (!tips || tips.length === 0) {
      tips = radialTips(node, plane);
      if (tips.length > 0) this.hardwareTips.set(name, tips);
    }
    return tips;
  }

  private lanternFromGlb(glassMat: THREE.MeshStandardMaterial): { holder: THREE.Group; part: HardwarePart } | null {
    const near = this.hardwareClone('ship_lantern', false);
    if (!near) return null;
    const far = this.hardwareClone('ship_lantern', true);
    const holder = new THREE.Group();
    holder.name = 'hw-lantern';
    for (const g of far ? [near, far] : [near]) {
      // The ship's own glass: setNightFactor ramps its emissive day -> night.
      g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.Material;
        if (o.name === 'glass' || /glass|flame/i.test(mat?.name ?? '')) mesh.material = glassMat;
      });
      holder.add(g);
    }
    return { holder, part: { near, far } };
  }

  /**
   * Swap the procedural cannons, wheel and capstan of one hull for the GLBs
   * (b3.4e). The pivots the update loop drives stay the same objects —
   * yawPivot/pitchPivot, mesh.wheel, mesh.anchorCapstan — so the barrel
   * elevation, the wheel's rudder reading and the capstan's anchor direction
   * are unchanged conventions; only what hangs off them changes. The IK grip
   * sets on those holders are re-derived from the GLB geometry.
   */
  private mountHardware(mesh: ShipMeshGroup, lanterns: HardwarePart[] = []): void {
    const parts: HardwarePart[] = [...lanterns];
    const keep = (o: THREE.Object3D) => o.name === 'upgrade-charged-cannon';
    const strip = (holder: THREE.Object3D, spare: ReadonlySet<THREE.Object3D>) => {
      for (const c of [...holder.children]) if (!spare.has(c) && !keep(c)) holder.remove(c);
    };
    const S = HW_CANNON_SCALE;
    for (const cannon of mesh.cannonMeshes) {
      const near = this.hardwareClone('cannon', false);
      if (!near) return;
      const far = this.hardwareClone('cannon', true);
      strip(cannon.root, new Set([cannon.yawPivot]));
      strip(cannon.pitchPivot, new Set());
      // Carriage: GLB +Z (the muzzle) onto the pivot's +X, the trunnions (GLB
      // barrel node origin) onto the pitch pivot, the base 0.36 m under the root.
      const body = new THREE.Group();
      body.name = 'hw-cannon-carriage';
      body.rotation.y = Math.PI * 0.5;
      body.scale.setScalar(S);
      cannon.root.add(body);
      const barrelHolder = new THREE.Group();
      barrelHolder.name = 'hw-cannon-barrel';
      barrelHolder.rotation.y = Math.PI * 0.5;
      barrelHolder.scale.setScalar(S);
      cannon.pitchPivot.add(barrelHolder);
      let trunnion: THREE.Vector3 | null = null;
      let breechZ = -0.5;
      // near first, then far: body.children / barrelHolder.children are [near, far].
      for (const g of far ? [near, far] : [near]) {
        const carriage = g.getObjectByName('cannon_body');
        const barrel = g.getObjectByName('barrel');
        if (!carriage || !barrel) continue;
        if (!trunnion) {
          trunnion = barrel.position.clone();
          barrel.updateMatrixWorld(true);
          breechZ = new THREE.Box3().setFromObject(barrel).min.z - barrel.position.z;
        }
        body.add(carriage);
        barrel.position.set(0, 0, 0);
        barrelHolder.add(barrel);
      }
      const nb = body.children;
      const bb = barrelHolder.children;
      if (nb[0]) parts.push({ near: nb[0], far: nb[1] ?? null });
      if (bb[0]) parts.push({ near: bb[0], far: bb[1] ?? null });
      const t = trunnion ?? new THREE.Vector3(0, 0.6, 0.02);
      body.position.set(-t.z * S, -t.y * S, 0);
      cannon.pitchPivot.userData[IK_GRIPS_KEY] = {
        kind: 'cannon',
        points: [new THREE.Vector3((breechZ + 0.1) * S, 0.08, 0.18), new THREE.Vector3((breechZ + 0.1) * S, 0.08, -0.18)],
      };
    }

    // Helm wheel: fitted to this hull's rim radius, spun by mesh.wheel.rotation.z.
    const wheelNear = this.hardwareClone('wheel', false);
    if (wheelNear) {
      const wheelFar = this.hardwareClone('wheel', true);
      strip(mesh.wheel, new Set());
      const ws = (mesh.wheelRimR + 0.16) / HW_WHEEL_TIP_R;
      for (const g of wheelFar ? [wheelNear, wheelFar] : [wheelNear]) { g.scale.setScalar(ws); mesh.wheel.add(g); }
      parts.push({ near: wheelNear, far: wheelFar });
      const tips = this.tipsOf('wheel', wheelNear.getObjectByName('wheel_body') ?? wheelNear, 'xy');
      if (tips.length >= 4) {
        mesh.wheel.userData[IK_GRIPS_KEY] = { kind: 'helm', points: tips.map((p) => p.clone().multiplyScalar(ws * 0.97)) };
      }
    }

    // Capstan: the base stays on the deck, the drum (bars) turns with the anchor.
    const capNear = this.hardwareClone('capstan', false);
    if (capNear) {
      const capFar = this.hardwareClone('capstan', true);
      const cap = mesh.anchorCapstan;
      strip(cap, new Set([mesh.anchorChain]));
      const base = new THREE.Group();
      base.name = 'hw-capstan-base';
      base.position.copy(cap.position);
      base.scale.setScalar(HW_CAPSTAN_SCALE);
      cap.parent?.add(base);
      for (const g of capFar ? [capNear, capFar] : [capNear]) {
        const b = g.getObjectByName('capstan_body');
        const d = g.getObjectByName('drum');
        if (b) base.add(b);
        if (d) { d.scale.setScalar(HW_CAPSTAN_SCALE); cap.add(d); }
      }
      const bodies = base.children;
      const drums = cap.children.filter((c) => c.name === 'drum');
      parts.push({ near: bodies[0], far: bodies[1] ?? null }, { near: drums[0], far: drums[1] ?? null });
      if (drums[0]) {
        const tips = this.tipsOf('capstan', drums[0], 'xz');
        if (tips.length >= 4) {
          cap.userData[IK_GRIPS_KEY] = { kind: 'capstan', points: tips.map((p) => p.clone().multiplyScalar(HW_CAPSTAN_SCALE)) };
        }
      }
    }

    mesh.hardware = { parts: parts.filter((p) => !!p.near), far: false, lanterns: lanterns.length };
    this.applyHardwareLod(mesh.hardware, this.quality === 'low');
  }

  private applyHardwareLod(hw: ShipHardwareMount, far: boolean): void {
    hw.far = far;
    for (const p of hw.parts) {
      p.near.visible = !far || !p.far;
      if (p.far) p.far.visible = far;
    }
  }

  /** Near <-> far sibling at the islands' FAR_SWAP distance (same hysteresis);
   *  the low tier never draws hardware LOD0 (D6). */
  private updateHardwareLod(mesh: ShipMeshGroup, distSq: number): void {
    const hw = mesh.hardware;
    if (!hw) return;
    const swap = farSwapDistance(this.quality);
    const threshold = hw.far ? swap * FAR_SWAP_HYSTERESIS : swap;
    const far = this.quality === 'low' || distSq > threshold * threshold;
    if (far !== hw.far) this.applyHardwareLod(hw, far);
  }

  /** Probe-only (hold-water-probe breach rows): extra hull-local holes drawn
   *  on one ship on top of the wire list, so a hold view of an open breach can
   *  be staged without a live cannon hit. Ids must not collide with real ones
   *  (use >= 900). Released with null. The server never sees them. */
  private breachDebug: { shipId: string; holes: ShipHole[] } | null = null;
  setBreachDebug(shipId: string | null, holes: ShipHole[] = []) {
    this.breachDebug = shipId ? { shipId, holes } : null;
  }

  /** Lazily built, shared across every breach on every hull. */
  private getHoleDecalGeo() {
    if (this.holeDecalGeo) return this.holeDecalGeo;
    const r = FLOODING.HOLE_VISUAL_RADIUS;
    // The torn edge itself is per hole now (ship/breach.ts, seeded by id).
    this.holeDecalGeo = { marker: new THREE.RingGeometry(r * 1.45, r * 1.8, 24) };
    return this.holeDecalGeo;
  }

  /**
   * Project a hull-local breach point onto the REAL lofted planking and return
   * the surface point + outward normal. Side hits query the station table at
   * the hole's own height and length; hits past the ends ride the raked stem or
   * transom instead (where the sections have pinched to nothing).
   */
  private hullBreachSurface(profile: HullProfile, hole: { x: number; y: number; z: number }) {
    const sts = profile.stations;
    const sternZ = sts[0].baseZ;
    const bowZ = sts[sts.length - 1].baseZ;
    const y = THREE.MathUtils.clamp(hole.y, -profile.draft * 0.85, profile.H * 0.95);
    if (hole.z <= sternZ + 0.25 || hole.z >= bowZ - 0.25) {
      // End cap: the transom / stem face. Sit the decal on the raked surface and
      // face it fore-and-aft, tilted with the rake so it hugs the timber.
      const bow = hole.z >= 0;
      const st = bow ? sts[sts.length - 1] : sts[0];
      const surf = stationSurfaceAt(st, y);
      const sign = bow ? 1 : -1;
      const rake = (st.slots[0].z - st.slots[st.slots.length - 1].z);
      const normal = new THREE.Vector3(0, rake * sign * 0.35, sign * (st.sheerY - st.keelY)).normalize();
      return {
        point: new THREE.Vector3(
          THREE.MathUtils.clamp(hole.x, -surf.x * 0.7, surf.x * 0.7),
          y,
          surf.z,
        ),
        normal,
      };
    }
    const surf = hullSurfacePointAt(profile, hole.z, y);
    const sign = hole.x >= 0 ? 1 : -1;
    return {
      point: new THREE.Vector3(sign * surf.x, y, hole.z),
      normal: new THREE.Vector3(sign * surf.nx, surf.ny, 0).normalize(),
    };
  }

  /** Build the decal group for one breach, hugging the planking at its exact
   *  point. Returns the HoleVis the update loop drives. */
  private buildHoleVis(mesh: ShipMeshGroup, hole: ShipHole): HoleVis {
    const geo = this.getHoleDecalGeo();
    const { point, normal } = this.hullBreachSurface(mesh.hullProfile, hole);
    const group = new THREE.Group();
    group.position.copy(point);
    const quat = new THREE.Quaternion().setFromUnitVectors(HULL_Z_AXIS, normal);
    // b2.3d: the frame is (strake tangent, up-across, normal); the tangent the
    // shader reads is the frame's own x, so mesh and cut tear the same way.
    const size = hole.size ?? 1;
    const R = holeVisualRadius(size);
    const seed = breachSeed(hole.id);
    const tangent = new THREE.Vector3();
    const edgeQuat = new THREE.Quaternion();
    breachBasis(strakeTangentAt(mesh.hullProfile, point, normal, tangent), normal, edgeQuat, tangent);
    const ext = breachExtent(seed, R);

    // NO dark opening disc on the outer face: the hull shader DISCARDS the
    // planking inside the torn outline, so the breach is a genuine see-through
    // hole. The edge is one merged mesh: char lip, 0.08 m wall, plank ends.
    const decal = new THREE.Group();
    const edgeGeo = buildBreachEdgeGeometry(seed, R).geometry;
    const edge = new THREE.Mesh(edgeGeo, this.holeRimMat);
    edge.name = 'hole-edge';
    decal.add(edge);
    decal.quaternion.copy(edgeQuat);
    group.add(decal);

    const gush = new THREE.Object3D();
    gush.name = 'hole-gush-anchor';
    gush.position.copy(normal).multiplyScalar(0.12);
    gush.quaternion.copy(quat);
    group.add(gush);

    const marker = new THREE.Mesh(geo.marker, this.holeMarkerMat);
    marker.name = 'hole-marker';
    marker.position.copy(normal).multiplyScalar(0.06);
    marker.quaternion.copy(quat);
    const markerScale = Math.max(0.8, (ext.max * 1.15) / (FLOODING.HOLE_VISUAL_RADIUS * 1.45));
    marker.scale.setScalar(markerScale);
    group.add(marker);
    mesh.root.add(group);

    // holes-06: THE SAME BREACH FROM INSIDE. The hold surfaces carry the
    // capsule cut (shell point -> inboard seat); here the torn inboard ring,
    // the water welling up through the sole for a hole below it, and the
    // backdrop that reads as dark sea or daylight through the opening.
    const inner = new THREE.Vector3();
    const innerNormal = new THREE.Vector3();
    const seat = this.seatBreachInboard(mesh, point, inner, innerNormal);
    const inboard = new THREE.Group();
    inboard.name = 'hole-inboard';
    const ring = new THREE.Group();
    ring.name = 'hole-rim-inboard';
    const ringFlipped = breachBasis(tangent, innerNormal, this.tempHoleQuat);
    const ringGeo = buildBreachEdgeGeometry(seed, R, { inboard: true, mirrorX: ringFlipped }).geometry;
    ring.add(new THREE.Mesh(ringGeo, this.holeRimMat));
    inboard.add(ring);
    const welling = new THREE.Mesh(this.getBreachWellingGeo(), this.getBreachWellingMat());
    welling.name = 'hole-welling';
    welling.scale.setScalar(ext.max / FLOODING.HOLE_VISUAL_RADIUS);
    inboard.add(welling);
    this.seatInboardPieces(inboard, ring, welling, inner, innerNormal, seat.belowSole, tangent);
    inboard.visible = seat.hasSeat;
    mesh.root.add(inboard);
    const backdrop = new THREE.Mesh(this.getBreachBackdropGeo(), this.getBreachBackdropMat());
    backdrop.name = 'hole-backdrop';
    this.seatBackdrop(backdrop, normal, point, inner, seat.onBoard, ext.max);
    group.add(backdrop);

    // NO DECK-SIDE DECAL. It painted a fake "torn planking" disc on the INBOARD
    // bulwark at y = H + 0.17 whenever hole.y > 0.5H — but PhysicsSystem clamps
    // every hole to 0.6H at most, so that disc always sat about a metre above
    // the real breach on planking that was not holed, while the genuine
    // see-through opening is visible from the hold through the discard shader
    // (ships-15).
    return {
      group, decal, marker, gush, patch: null, point, normal,
      src: new THREE.Vector3(hole.x, hole.y, hole.z), patched: false,
      inner, innerNormal, hasSeat: seat.hasSeat, belowSole: seat.belowSole,
      inboard, ring, welling, backdrop,
      size, R, seed, tangent, edgeGeo, ringGeo, ringFlipped, markerScale,
    };
  }

  /**
   * Where a breach comes out INSIDE the hold (holes-06). Above the sole the
   * tube runs straight inboard to the lining's inner face; below it (most of
   * HOLE_BAND_Y 0.10..0.45 is under the 0.35 m sole) it climbs to the sole
   * edge above the wound, so from the hold you look down into the bilge and
   * see the sea coming up. Forward or aft of the hold there is no lining to
   * cut: the seat collapses onto the shell point (the shell's own sphere).
   */
  private seatBreachInboard(
    mesh: ShipMeshGroup,
    point: THREE.Vector3,
    inner: THREE.Vector3,
    innerNormal: THREE.Vector3,
  ): { hasSeat: boolean; belowSole: boolean; onBoard: boolean } {
    const side = point.x < 0 ? -1 : 1;
    if (Math.abs(point.z) > mesh.holdHalfLen - 0.05) {
      inner.copy(point);
      innerNormal.set(-side, 0, 0);
      return { hasSeat: false, belowSole: false, onBoard: false };
    }
    const half = mesh.holdHalfAt(point.z);
    if (point.y > mesh.lockerTop + 0.05) {
      // b2.3e: above the stowage lockers the hold's skin is the inner
      // planking 0.12 m inboard of the shell, so the tube ends 1 cm past it.
      inner.set(side * (Math.max(half, mesh.ceilingAt(point.z, point.y)) - 0.01), point.y, point.z);
      innerNormal.set(-side, 0, 0);
      return { hasSeat: true, belowSole: false, onBoard: false };
    }
    if (point.y >= HOLD_FLOOR_Y + 0.06) {
      // The angled bilge board stands 0.24 m inboard of the lining over the
      // whole above-sole band, so the tube ends 1 cm past ITS inboard face:
      // seated on the lining, the board hid the opening from every pose in
      // the hold (b2.3c probe, 0% open at the seat).
      const board = Math.abs(point.z) < mesh.holdHalfLen * BILGE_BOARD_LEN_F
        ? mesh.bilgeFaceAt(side, point.y) : null;
      if (board && Math.abs(board.x) < half) {
        innerNormal.set(board.nx, board.ny, 0);
        inner.set(board.x + board.nx * 0.01, point.y + board.ny * 0.01, point.z);
        return { hasSeat: true, belowSole: false, onBoard: true };
      }
      inner.set(side * (half - 0.01), point.y, point.z);
      innerNormal.set(-side, 0, 0);
      return { hasSeat: true, belowSole: false, onBoard: false };
    }
    // Below the sole the opening wells up through the sole in FRONT of the
    // bilge board: the board's foot crosses the sole ~0.39 m inboard of the
    // lining, so a seat at the lining edge hid all but a crescent of the
    // welling behind it (b2.3e hold-water-probe, breach-below 0.0%).
    const reach = FLOODING.HOLE_VISUAL_RADIUS * 0.9;
    const foot = Math.abs(point.z) < mesh.holdHalfLen * BILGE_BOARD_LEN_F
      ? mesh.bilgeFaceAt(side, HOLD_FLOOR_Y + 0.004) : null;
    const clear = foot ? Math.min(half, Math.abs(foot.x)) : half;
    inner.set(side * Math.max(0.2, clear - reach), HOLD_FLOOR_Y + 0.004, point.z);
    innerNormal.set(0, 1, 0);
    return { hasSeat: true, belowSole: true, onBoard: false };
  }

  private seatInboardPieces(
    inboard: THREE.Group, ring: THREE.Group, welling: THREE.Mesh,
    inner: THREE.Vector3, innerNormal: THREE.Vector3, belowSole: boolean,
    tangent: THREE.Vector3,
  ) {
    inboard.position.copy(inner);
    // The ring tears along the strake like the outboard edge (b2.3d).
    breachBasis(tangent, innerNormal, ring.quaternion);
    ring.position.copy(innerNormal).multiplyScalar(0.006);
    const q = this.tempHoleQuat.setFromUnitVectors(HULL_Z_AXIS, innerNormal);
    welling.quaternion.copy(q);
    // In the cut, a hand below the sole top: the sea boiling up into the bilge.
    welling.position.copy(innerNormal).multiplyScalar(-0.05);
    welling.visible = belowSole;
  }

  /**
   * The sea / daylight the hold sees through the opening. Seated on the bilge
   * board, the eye looks through the board cut into the unlit gap between the
   * board and the lining, which rendered near-black (3,3,8) at the seat (b2.3c
   * probe): so there the backdrop moves just behind the board's back face
   * (0.16 m board, ~0.17 m along the tube) and widens to 0.4 m, filling the
   * gap the cut exposes. Elsewhere it stays on the shell. Group-local (the
   * group sits on the shell point), always facing inboard (-normal).
   */
  private seatBackdrop(
    backdrop: THREE.Mesh, normal: THREE.Vector3,
    point: THREE.Vector3, inner: THREE.Vector3, onBoard: boolean,
    /** Furthest point of the torn outline (b2.3d): the disc must cover it. */
    reach: number,
  ) {
    const disc = FLOODING.HOLE_VISUAL_RADIUS * 1.04;
    if (onBoard) {
      const out = this.tempHoleNormal.copy(point).sub(inner).normalize();
      backdrop.position.copy(inner).sub(point).addScaledVector(out, BREACH_BACKDROP_BEHIND_BOARD);
      backdrop.scale.setScalar(Math.max(BREACH_BACKDROP_BOARD_R, reach * 1.1) / disc);
    } else {
      backdrop.position.copy(normal).multiplyScalar(0.05);
      backdrop.scale.setScalar(Math.max(1, (reach * 1.1) / disc));
    }
    backdrop.quaternion.setFromUnitVectors(HULL_Z_AXIS, this.tempHoleNormal.copy(normal).negate());
  }

  private breachWellingGeo: THREE.BufferGeometry | null = null;
  private breachWellingMat: THREE.ShaderMaterial | null = null;
  private breachBackdropGeo: THREE.BufferGeometry | null = null;
  private breachBackdropMat: THREE.ShaderMaterial | null = null;
  private readonly breachFxUniforms = { uTime: { value: 0 }, uDay: { value: 1 } };
  private inboardPatchGeo: { planks: THREE.BufferGeometry; nails: THREE.BufferGeometry } | null = null;
  private nailHeadMat: THREE.MeshStandardMaterial | null = null;
  private readonly tempHoleNormal = new THREE.Vector3();

  private getBreachWellingGeo() {
    this.breachWellingGeo ??= new THREE.CircleGeometry(FLOODING.HOLE_VISUAL_RADIUS * 0.96, 20);
    return this.breachWellingGeo;
  }

  /** Sea welling up through the cut sole: expanding foam rings over hold-water
   *  teal, the centre heaving. One shared program, time from the frame. */
  private getBreachWellingMat() {
    this.breachWellingMat ??= new THREE.ShaderMaterial({
      name: 'hole-welling',
      uniforms: { uTime: this.breachFxUniforms.uTime },
      vertexShader: `uniform float uTime; varying vec2 vP;
void main() {
  vP = position.xy / ${(FLOODING.HOLE_VISUAL_RADIUS * 0.96).toFixed(4)};
  vec3 p = position;
  p.z += 0.035 * (1.0 - dot(vP, vP)) * (0.65 + 0.35 * sin(uTime * 5.3));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,
      fragmentShader: `uniform float uTime; varying vec2 vP;
void main() {
  float r = length(vP);
  float rings = smoothstep(0.55, 1.0, fract(r * 2.6 - uTime * 0.95)) * (1.0 - r);
  float boil = smoothstep(0.4, 0.0, r) * (0.3 + 0.2 * sin(uTime * 7.0 + r * 9.0));
  vec3 col = mix(vec3(0.07, 0.25, 0.26), vec3(0.8, 0.9, 0.92), clamp(rings + boil, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    return this.breachWellingMat;
  }

  private getBreachBackdropGeo() {
    this.breachBackdropGeo ??= new THREE.CircleGeometry(FLOODING.HOLE_VISUAL_RADIUS * 1.04, 20);
    return this.breachBackdropGeo;
  }

  /** What the hold sees through a breach: dark green sea below the surface,
   *  daylight above it (dimmed at night), split at the world waterline so a
   *  wound that dips under the swell shows the sea climbing across it. */
  private getBreachBackdropMat() {
    this.breachBackdropMat ??= new THREE.ShaderMaterial({
      name: 'hole-backdrop',
      side: THREE.FrontSide,
      uniforms: this.breachFxUniforms,
      vertexShader: `varying float vWorldY; varying vec2 vP;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorldY = w.y; vP = position.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
      fragmentShader: `uniform float uTime; uniform float uDay; varying float vWorldY; varying vec2 vP;
void main() {
  float air = smoothstep(-0.05, 0.05, vWorldY + 0.03 * sin(uTime * 1.7 + vP.x * 9.0));
  float caustic = 0.5 + 0.5 * sin(vP.x * 23.0 + uTime * 2.1) * sin(vP.y * 19.0 - uTime * 1.6);
  vec3 sea = vec3(0.025, 0.1, 0.11) + vec3(0.02, 0.07, 0.07) * caustic * smoothstep(-0.8, 0.0, vWorldY);
  vec3 sky = vec3(0.74, 0.82, 0.86) * uDay;
  gl_FragColor = vec4(mix(sea * mix(0.45, 1.0, uDay), sky, air), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
    return this.breachBackdropMat;
  }

  /** Three short planks laid side by side plus six nail heads: the carpenter's
   *  side of the repair, mirrored on the lining (or the sole) at the seat. */
  private getInboardPatchGeo() {
    if (this.inboardPatchGeo) return this.inboardPatchGeo;
    const planks: THREE.BufferGeometry[] = [];
    const nails: THREE.BufferGeometry[] = [];
    const rows = [-0.18, 0, 0.18];
    rows.forEach((y, i) => {
      const len = 0.78 - i * 0.05;
      const z = 0.018 + (i % 2) * 0.006;
      planks.push(new THREE.BoxGeometry(len, 0.17, 0.035).translate(((i % 2) - 0.5) * 0.04, y, z));
      for (const sx of [-1, 1]) {
        nails.push(new THREE.CylinderGeometry(0.017, 0.019, 0.012, 6)
          .rotateX(Math.PI / 2)
          .translate(sx * (len * 0.5 - 0.07), y + (sx > 0 ? 0.02 : -0.02), z + 0.02));
      }
    });
    this.inboardPatchGeo = { planks: mergeGeometries(planks)!, nails: mergeGeometries(nails)! };
    return this.inboardPatchGeo;
  }

  /**
   * A BREACH THAT MOVED IS STILL THE SAME BREACH.
   *
   * `holeVis` is keyed by ShipHole.id and the old sync loop only ever built or
   * disposed, never re-read x/y/z. Two server paths move a live id:
   * PhysicsSystem's fire burn-down walks a firebomb char from FIRE_HOLE_START_Y
   * 1.05 down to the waterline at 0.06 m/s under the same id, and placeHole
   * recycles the nearest PATCHED slot once the hull is at MAX_HOLES_PER_SHIP,
   * so a fresh hit can reopen a slot on the other side of the ship. Both left
   * the drawn hole, the see-through disc, the gush anchor and the repair halo
   * at the old point while evaluateHoleFlood flooded from the new one
   * (ships-26). Re-seat in place rather than rebuild: burn-down moves the hole
   * every frame for ~16 s and rebuilding would churn a Group per frame.
   */
  private reseatHoleVis(mesh: ShipMeshGroup, hole: ShipHole, vis: HoleVis) {
    const { point, normal } = this.hullBreachSurface(mesh.hullProfile, hole);
    vis.point.copy(point);
    vis.normal.copy(normal);
    vis.src.set(hole.x, hole.y, hole.z);
    const quat = this.tempHoleQuat.setFromUnitVectors(HULL_Z_AXIS, normal);
    vis.group.position.copy(point);
    breachBasis(strakeTangentAt(mesh.hullProfile, point, normal, vis.tangent), normal, vis.decal.quaternion, vis.tangent);
    vis.gush.position.copy(normal).multiplyScalar(0.12);
    vis.gush.quaternion.copy(quat);
    vis.marker.position.copy(normal).multiplyScalar(0.06);
    vis.marker.quaternion.copy(quat);
    const seat = this.seatBreachInboard(mesh, point, vis.inner, vis.innerNormal);
    vis.hasSeat = seat.hasSeat;
    vis.belowSole = seat.belowSole;
    const flipped = breachBasis(vis.tangent, vis.innerNormal, this.tempHoleQuat);
    if (flipped !== vis.ringFlipped) {
      // The seat turned (lining <-> sole): re-mirror the inboard tear.
      vis.ringGeo.dispose();
      vis.ringGeo = buildBreachEdgeGeometry(vis.seed, vis.R, { inboard: true, mirrorX: flipped }).geometry;
      (vis.ring.children[0] as THREE.Mesh).geometry = vis.ringGeo;
      vis.ringFlipped = flipped;
    }
    this.seatInboardPieces(vis.inboard, vis.ring, vis.welling, vis.inner, vis.innerNormal, seat.belowSole, vis.tangent);
    this.seatBackdrop(vis.backdrop, normal, point, vis.inner, seat.onBoard, breachExtent(vis.seed, vis.R).max);
    // The plank was nailed over the OLD wound. A recycled slot is a fresh
    // hole by definition, so the carpentry goes with it.
    this.dropPlankPatch(mesh, vis);
  }

  private disposeHoleVis(mesh: ShipMeshGroup, vis: HoleVis) {
    mesh.root.remove(vis.group);
    mesh.root.remove(vis.inboard);
    this.dropPlankPatch(mesh, vis);
    vis.edgeGeo.dispose();
    vis.ringGeo.dispose();
  }

  /** Take the repair off a breach and free its per-hole plank geometry. */
  private dropPlankPatch(mesh: ShipMeshGroup, vis: HoleVis) {
    if (!vis.patch) return;
    mesh.root.remove(vis.patch);
    vis.patch.traverse((o) => { if (o.userData.ownGeometry) (o as THREE.Mesh).geometry.dispose(); });
    vis.patch = null;
  }

  /** A crossed pair of rough planks nailed over a repaired breach, flush at the
   *  breach's own point and quaternion — patch and hole are the same entity now,
   *  so a plank can never float over a still-open hole.
   *
   *  Cut FRESH and pale (deck timber, not the tarred hull trim it used to use)
   *  and set on a dark backing board: the old 0.66 x 0.15 dark-on-dark cross was
   *  unreadable past about four metres, so from the water you couldn't tell a
   *  planked hull from a holed one. Now the repair is legible across a broadside.
   */
  private addPlankPatch(mesh: ShipMeshGroup, vis: HoleVis, seed: number) {
    // Container at identity: the outboard cross and (holes-06) the inboard
    // planks the carpenter actually nails on from the hold.
    const container = new THREE.Group();
    container.userData.isPlankPatch = true;
    const patch = new THREE.Group();
    patch.name = 'hole-patch';
    this.plankPatchMat ??= new THREE.MeshStandardMaterial({
      map: this.deckTex,
      color: 0xd7b98c,
      roughness: 0.88,
    });
    this.nailHeadMat ??= new THREE.MeshStandardMaterial({ color: 0x3b3834, metalness: 0.7, roughness: 0.45 });
    // b2.3d: 2-3 fresh planks laid ALONG the strake over the torn outline (as
    // long as the wound + 0.15 m), two nails at each plank end. Pale on the
    // dark hull, so a planked breach still reads across a broadside.
    const pg = buildBreachPatchGeometry(vis.seed, vis.R, vis.size);
    const planks = new THREE.Mesh(pg.planks, this.plankPatchMat);
    planks.name = 'hole-patch-planks';
    planks.castShadow = true;
    planks.userData.ownGeometry = true;
    const nails = new THREE.Mesh(pg.nails, this.nailHeadMat);
    nails.name = 'hole-patch-nails';
    nails.userData.ownGeometry = true;
    patch.add(planks, nails);
    // Same frame as the torn edge; the carpenter's slight skew stays under 2 deg.
    breachBasis(vis.tangent, vis.normal, patch.quaternion);
    patch.rotateZ(((seed % 3) - 1) * 0.03);
    patch.position.copy(vis.point).addScaledVector(vis.normal, 0.03);
    patch.userData.isPlankPatch = true;
    container.add(patch);
    if (vis.hasSeat) {
      const geo = this.getInboardPatchGeo();
      const inboard = new THREE.Group();
      inboard.name = 'hole-patch-inboard';
      inboard.userData.isPlankPatch = true;
      const planks = new THREE.Mesh(geo.planks, this.plankPatchMat);
      planks.name = 'hole-patch-inboard-planks';
      const nails = new THREE.Mesh(geo.nails, this.nailHeadMat);
      nails.name = 'hole-patch-inboard-nails';
      inboard.add(planks, nails);
      inboard.position.copy(vis.inner).addScaledVector(vis.innerNormal, 0.004);
      breachBasis(vis.tangent, vis.innerNormal, inboard.quaternion);
      inboard.rotateZ(((seed % 3) - 1) * 0.03);
      container.add(inboard);
    }
    mesh.root.add(container);
    vis.patch = container;
  }

  private addSwiftSailTrim(
    sail: THREE.Mesh,
    width: number,
    height: number,
    targets: THREE.Object3D[],
    staySail = false,
  ) {
    const trimGroup = new THREE.Group();
    trimGroup.name = 'upgrade-swift-sail-trim';
    trimGroup.visible = false;
    const trimMat = new THREE.MeshBasicMaterial({
      color: 0xf9d85b,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0x56b7ff,
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Trim is PAINT ON CANVAS: every stripe is clamped inside the sail's own
    // quad, rotation included. The stay-sail stripes were authored at y = 0.48h
    // with a 0.78h height, so most of the plane hung outside the sail — and once
    // the boom swung in a storm those loose panels raked down through the hull and
    // into the ocean as two bright yellow/blue slabs. Clamped, a stripe can never
    // leave the sail it is painted on, whatever the rig is doing.
    const addStripe = (
      w: number,
      h: number,
      x: number,
      y: number,
      rotZ = 0,
      material: THREE.Material = trimMat,
    ) => {
      const cos = Math.abs(Math.cos(rotZ));
      const sin = Math.abs(Math.sin(rotZ));
      const halfX = (w * cos + h * sin) * 0.5;
      const halfY = (w * sin + h * cos) * 0.5;
      const slackX = Math.max(0, width * 0.5 - halfX);
      const slackY = Math.max(0, height * 0.5 - halfY);
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
      stripe.position.set(
        THREE.MathUtils.clamp(x, -slackX, slackX),
        THREE.MathUtils.clamp(y, -slackY, slackY),
        0.035,
      );
      stripe.rotation.z = rotZ;
      stripe.renderOrder = 4;
      trimGroup.add(stripe);
    };

    if (staySail) {
      addStripe(width * 0.11, height * 0.78, width * 0.44, height * 0.48, -0.42);
      addStripe(width * 0.08, height * 0.62, width * 0.7, height * 0.42, -0.42, edgeMat);
    } else {
      addStripe(width * 0.055, height * 0.96, -width * 0.43, 0, 0, edgeMat);
      addStripe(width * 0.055, height * 0.96, width * 0.43, 0, 0, edgeMat);
      addStripe(width * 0.78, height * 0.06, 0, height * 0.43);
      addStripe(width * 0.065, height * 0.92, -width * 0.08, 0, 0.42);
      addStripe(width * 0.065, height * 0.92, width * 0.08, 0, -0.42);
    }

    sail.add(trimGroup);
    targets.push(trimGroup);
  }

  private updateUpgradeVisuals(mesh: ShipMeshGroup, activeUpgrades: ReadonlySet<ShipUpgradeType>) {
    const types = this.upgradeVisualTypes ??= Object.keys(mesh.upgradeVisuals) as ShipUpgradeType[];
    for (const type of types) {
      const active = activeUpgrades.has(type);
      for (const visual of mesh.upgradeVisuals[type]) visual.visible = active;
    }

    const swift = activeUpgrades.has('swift_sails');
    for (const sail of mesh.sails) this.setSailUpgradeMaterial(sail, swift, false);
    for (const sail of mesh.furledSails) this.setSailUpgradeMaterial(sail, swift, true);
    for (const sail of mesh.proxySails) this.setSailUpgradeMaterial(sail, swift, false);
    this.setSailUpgradeMaterial(mesh.lod2Sails, swift, false);
  }

  private setSailUpgradeMaterial(sail: THREE.Mesh, swift: boolean, furled: boolean) {
    const material = sail.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    material.color.set(swift ? (furled ? 0xd8b954 : 0xffefb2) : 0xf5edd2);
    material.emissive.set(swift ? 0x4c3300 : 0x221a08);
    material.emissiveIntensity = swift ? (furled ? 0.14 : 0.1) : 0.04;
    material.roughness = swift ? 0.48 : 0.62;
  }

  update(
    ships: Ship[],
    players: Player[],
    t: number,
    dt = 1 / 60,
    snapshotAge = 0,
    cameraPosition?: THREE.Vector3,
    localPlayerId?: string,
    storm: ShipStormSource = 0,
    /**
     * WHERE A HULL SOMEBODY ELSE IS SAILING ACTUALLY IS, on the server's
     * timeline. Null for a hull nobody has history for yet, and — deliberately —
     * null for the hull the local player is aboard: he is riding it, his camera
     * is bolted to it and his aim is measured from it, so it stays predicted
     * along with him. See src/client/network/RemoteInterpolation.ts.
     */
    remoteHullPose?: (shipId: string) => { x: number; y: number; z: number; yaw: number } | null,
  ) {
    this.frameIndex++;
    const wind = this.windOverride ?? sampleWind(t);
    // `t` is already the server-synced ocean clock in Game.ts.
    const waveT = t;
    const positionAlpha = 1 - Math.exp(-18 * dt);
    const rotationAlpha = 1 - Math.exp(-20 * dt);
    const cannonOperators = this.cannonOperators;
    for (const slots of cannonOperators.values()) slots.length = 0;
    for (const player of players) {
      if (!player.atCannon || !player.onShipId) continue;
      let slots = cannonOperators.get(player.onShipId);
      if (!slots) {
        slots = [];
        cannonOperators.set(player.onShipId, slots);
      }
      slots[player.cannonIndex] = player;
    }

    // Night lantern budget: only the nearest few ships get a real PointLight.
    const nightLightIds = this.pickNightLightShips(ships, cameraPosition);
    const lanternEmissive = THREE.MathUtils.lerp(0.15, 2.2, this.nightFactor);

    // Indexed here and through every per-hull loop below. `for…of` over an array
    // allocates an iterator, and at 'high' ten hulls run the full detail path —
    // sails, furled sails, pennants, lantern glass, holes — so those are dozens
    // of iterators a frame for lists whose length is known.
    for (let shipIdx = 0; shipIdx < ships.length; shipIdx++) {
      const ship = ships[shipIdx];
      let mesh = this.shipMeshes.get(ship.id);
      if (!mesh) {
        this.buildShip(ship);
        mesh = this.shipMeshes.get(ship.id)!;
      }

      if (!ship.alive) {
        mesh.root.visible = false;
        mesh.detailRoot.visible = false;
        mesh.proxyRoot.visible = false;
        mesh.lod1Root.visible = false;
        mesh.lod2Root.visible = false;
        mesh.wake.group.visible = false;
        continue;
      }

      mesh.root.visible = true;
      const stats = SHIP_STATS[ship.type];
      const activeUpgrades = this.activeUpgrades;
      activeUpgrades.clear();
      for (let u = 0; u < ship.upgrades.length; u++) activeUpgrades.add(ship.upgrades[u].type);
      this.updateUpgradeVisuals(mesh, activeUpgrades);
      // b4.2d: the detail hull is LOD0 (< 30 m, + 10% hysteresis); LOD1
      // (30-90 m) is its baked variant. detailDistance is the outer edge of
      // LOD1, where the wake arms have faded to nothing.
      const detailDistance = SHIP_LOD_BANDS[1] * (1 + SHIP_LOD_HYSTERESIS);
      const distSq = cameraPosition
        ? (ship.position.x - cameraPosition.x) ** 2 + (ship.position.z - cameraPosition.z) ** 2
        : 0;
      const localCrewShip = !!localPlayerId && ship.crewIds.includes(localPlayerId);
      mesh.lodLevel = selectShipLod(mesh.lodLevel, Math.sqrt(distSq), {
        quality: this.quality, phone: this.lodPhone, ownHull: !cameraPosition || localCrewShip,
      });
      let detailNear = mesh.lodLevel === 0;
      // A hull's detail root is ~78 geometries and it flips on one frame when
      // the camera crosses detailDistance — the same shape of stall the island
      // reveal was built to flatten, and two ships crossing together were
      // measured putting 140 geometries onto a single frame. Its FIRST
      // appearance goes through the shared per-frame allowance; every one after
      // that is a plain assignment. The proxy is not gated: it swaps out only
      // once the detail root is genuinely up, so the hull is never missing.
      showWhenAffordable(mesh.detailRoot, detailNear);
      // Everything downstream — the proxy sails, the waterline foam — keys off
      // detailNear, so it has to mean what is ACTUALLY up. A hull waiting a
      // frame for the allowance must keep its proxy and its proxy sails, or it
      // sails for two frames with no canvas on it.
      detailNear = mesh.detailRoot.visible;
      mesh.lod1Root.visible = !detailNear && mesh.lodLevel <= 1;
      mesh.lod2Root.visible = !detailNear && mesh.lodLevel === 2;
      mesh.proxyRoot.visible = !detailNear && mesh.lodLevel === 3;
      applyRiggingLod(mesh.rigSet, cameraPosition && !localCrewShip ? Math.sqrt(distSq) : 0, !detailNear && mesh.lodLevel === 3);
      // b3.4e: the queue-window fallback gives way once the library has the
      // hardware; after that only the near/far sibling swap runs.
      // The world set lands on ONE frame, and every hull in view mounts then:
      // six galleons were ~114 first draws on a single frame against an
      // allowance of 48. The late mount is a first appearance like any other,
      // so it pays the shared allowance and waits a frame when it cannot (a
      // hull costlier than the whole allowance lands on a frame of its own).
      if (!mesh.hardware && detailNear && this.hardwareReady()) {
        const price = this.hardwareMountCost(mesh, distSq);
        if (price <= firstDrawRemaining() || firstDrawFrameUntouched()) {
          spendFirstDraw(price);
          this.mountHardware(mesh);
        }
      }
      if (mesh.hardware && detailNear) this.updateHardwareLod(mesh, distSq);
      // b4.3c: the ship kit mounts the same way (a late first appearance that
      // pays the shared first-draw allowance), once both files are in.
      if (!mesh.kit && mesh.lodLevel <= 2 && this.kitReady()) {
        const price = this.kitPrice ??= kitDrawCount(mountShipKit(mesh.kitSockets, this.kitSource!, null));
        if (price <= firstDrawRemaining() || firstDrawFrameUntouched()) {
          spendFirstDraw(price);
          this.mountKit(mesh);
        }
      }
      const extrapolation = Math.min(0.14, snapshotAge + dt * 0.5);
      // Local storm sea-state feeds the SAME boosted Gerstner field the ocean
      // surface uses, so hulls keep riding the visible water inside a storm.
      const storm01 = typeof storm === 'number'
        ? THREE.MathUtils.clamp(storm, 0, 1)
        : getStormWaveIntensity(storm, ship.position.x, ship.position.z);
      // Wave attitude: prefer server-sent pitch/roll/heave while the snapshot is
      // FRESH (they carry non-deterministic wind/turn heel + flood listing), but
      // blend toward the deterministic client Gerstner attitude as it goes stale
      // (>180ms) so rocking never freezes between late snapshots.
      const dyn = ship as Ship & { pitch?: number; roll?: number; heave?: number; waterLevel?: number };
      const serverPitch = typeof dyn.pitch === 'number' && Number.isFinite(dyn.pitch)
        ? THREE.MathUtils.clamp(dyn.pitch, -0.5, 0.5) : null;
      const serverRoll = typeof dyn.roll === 'number' && Number.isFinite(dyn.roll)
        ? THREE.MathUtils.clamp(dyn.roll, -0.6, 0.6) : null;
      const serverHeave = typeof dyn.heave === 'number' && Number.isFinite(dyn.heave)
        ? THREE.MathUtils.clamp(dyn.heave, -2, 2) : null;
      const motion = this.computeWaveMotion(
        ship.position.x, ship.position.z, mesh.root.rotation.y,
        stats.length * 0.5, stats.width * 0.5, waveT, storm01,
      );
      const waterLevel = THREE.MathUtils.clamp(
        typeof dyn.waterLevel === 'number' && Number.isFinite(dyn.waterLevel) ? dyn.waterLevel : 0, 0, 1,
      );
      const staleBlend = THREE.MathUtils.clamp((snapshotAge - 0.18) / 0.04, 0, 1);
      // Client heave pins the hull to the shared wave surface (minus flood
      // freeboard drop) — used when the server residual is missing or stale.
      const clientHeave = THREE.MathUtils.clamp(
        motion.surfaceY - waterLevel * 0.8 - ship.position.y, -2.5, 2.5,
      );
      const basePitch = serverPitch === null ? motion.pitch : THREE.MathUtils.lerp(serverPitch, motion.pitch, staleBlend);
      const baseRoll = serverRoll === null ? motion.roll : THREE.MathUtils.lerp(serverRoll, motion.roll, staleBlend);
      // THE DRAWN ATTITUDE IS THE REPLICATED ATTITUDE (physics-18).
      //
      // This block used to add a client-only flood list (±0.122 rad), a
      // client-only flood trim (±0.06) and a client-only settle on top of the
      // server's FREEBOARD_DROP — every one of them a second copy of something
      // the server already owns and already puts on the wire: floodListTargets
      // feeds ship.pitch/ship.roll through the attitude spring (LIST_ROLL_MAX
      // 0.25 / LIST_TRIM_MAX 0.15) and the buoyancy target already drops by
      // 0.8·waterLevel. So the list was applied TWICE, and worse, the hull the
      // crew were drawn on was not the hull the server floods: a breach the
      // client tilted above the visible water was gushing on the server.
      //
      // Now that crew and camera ride this matrix (DECK-01), a client-only term
      // is not a flourish — it is a metre of daylight under a pirate's boots
      // and a hitbox that disagrees with the body you can see. Nothing is added
      // here that the server has not sent.
      const heave = ship.sinking
        ? 0
        : (serverHeave === null ? clientHeave : THREE.MathUtils.lerp(serverHeave, clientHeave, staleBlend));
      // A HULL IS PLACED FROM THE BUFFER WHEN IT IS SOMEBODY ELSE'S.
      //
      // `extrapolation` above is `min(0.14, snapshotAge + dt x 0.5)` — an age
      // measured from when the PACKET LANDED, so the wire's arrival jitter went
      // straight into where a 20-metre hull was drawn, and the next snapshot
      // yanked it back. On the biggest moving object in the game that is the
      // most visible correction there is, and it carries the crew and the
      // waterline with it. The heave, the pitch and the roll are NOT taken from
      // the buffer: those are the deterministic wave attitude, computed from the
      // shared Gerstner clock, and they are already continuous.
      const buffered = remoteHullPose && !localCrewShip ? remoteHullPose(ship.id) : null;
      this.tempShipPos.set(
        buffered ? buffered.x : ship.position.x + ship.velocity.x * extrapolation,
        (buffered ? buffered.y : ship.position.y) + heave,
        buffered ? buffered.z : ship.position.z + ship.velocity.z * extrapolation,
      );
      if (mesh.root.position.distanceToSquared(this.tempShipPos) > 75 * 75) {
        mesh.root.position.copy(this.tempShipPos);
      } else {
        mesh.root.position.lerp(this.tempShipPos, positionAlpha);
      }
      const targetRotation = buffered ? buffered.yaw : ship.rotation + ship.angularVelocity * extrapolation;
      mesh.root.rotation.y += angleWrap(targetRotation - mesh.root.rotation.y) * rotationAlpha;

      // Waterline contact collar: always on (a hull at anchor still has a wet
      // edge — that is the whole point), brightening as the ship makes way.
      {
        const foamMat = mesh.waterlineFoam.material as THREE.MeshBasicMaterial;
        // The planking's wet line, in HULL-LOCAL metres: where the sea actually
        // is minus where the hull is. Normally ~0 (the loft's y = 0 slot IS the
        // design waterline); it climbs the topside as she settles, so a sinking
        // hull darkens from the boot-top up instead of staying showroom-dry.
        mesh.plankUniforms.uWetY.value =
          gerstnerHeight(mesh.root.position.x, mesh.root.position.z, waveT, WAVE_PARAMS, storm01)
          - mesh.root.position.y;
        const shipSpeed = Math.hypot(ship.velocity.x, ship.velocity.z);
        const speed01 = THREE.MathUtils.clamp(shipSpeed / 8, 0, 1);
        const collarSpeed01 = THREE.MathUtils.clamp(shipSpeed / (SHIP_STATS[ship.type]?.maxSpeed ?? 13), 0, 1);
        const breathe = 0.9 + 0.1 * Math.sin(t * 1.7 + ship.position.x * 0.05);
        mesh.waterlineFoam.visible = detailNear && !ship.sinking;
        // b4.2e (ships-04): 40-50% alpha at rest (the texture breaks it up),
        // brighter as the bow wave builds.
        foamMat.opacity = (0.46 + 0.3 * speed01 + 0.14 * storm01) * breathe;
        // ── WHICH ONE IS MINE ──────────────────────────────────────────────
        // The swallowtail pennant says it at any range; a thin gilded edge on
        // the boot-top says it at boarding range (plank shader uOwnEdge). It
        // used to gild the whole foam collar, which read as a sand tray under
        // the hull at a berth (ships-04), so the collar stays sea-white.
        mesh.ownPennant.visible = localCrewShip;
        mesh.plankUniforms.uOwnEdge.value = localCrewShip ? 1 : 0;
        // Cancel the hull's pitch/roll (previous frame's settled value — one
        // frame of lag is invisible) so the wet edge stays glued to the sea
        // instead of riding the ship's attitude out of the water. The collar
        // ends up on a YAW-ONLY frame: the root is Ry·Rx·Rz, so the exact
        // inverse of its attitude (leaving the yaw alone) is Rz(-roll)·Rx(-pitch),
        // which is what Euler order 'ZXY' with y = 0 spells. The old
        // `rotation.set(-x, 0, -z)` was composed in the SAME wrong order as the
        // bug it was cancelling and left the ribbon tilted on every heading but
        // north/south (ships-01).
        if (foamMat.map) {
          foamMat.map.offset.x = (t * (0.03 + speed01 * 0.12)) % 1;
        }
        // Yaw-only frame, speed/slope-driven widths, vertices on the local Gerstner surface (ship/wake.ts).
        seatWaterlineCollar(mesh.waterlineFoam, mesh.root, waveT, storm01, collarSpeed01);
      }
      for (let s = 0; s < mesh.proxySails.length; s++) {
        const sail = mesh.proxySails[s];
        sail.visible = !detailNear && ship.sailHeight > 0.06;
        sail.rotation.y = THREE.MathUtils.lerp(sail.rotation.y, ship.sailAngle, 1 - Math.exp(-8 * dt)); // 1:1 with the simulated brace
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, Math.max(0.18, ship.sailHeight), 1 - Math.exp(-8 * dt));
      }
      if (mesh.lod1Root.visible) this.updateLod2Sails(mesh, ship, dt, mesh.lod1Sails);
      if (mesh.lod2Root.visible) this.updateLod2Sails(mesh, ship, dt);
      if (!detailNear) {
        // No client-only heel here either: the server's own attitude spring
        // already carries turn heel (±0.06) and wind heel, sampled from the real
        // Gerstner slopes at bow/stern/rails.
        const attitudeAlpha = 1 - Math.exp(-(ship.sinking ? 6 : 3) * dt);
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, basePitch, attitudeAlpha);
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, baseRoll, attitudeAlpha);
        // LOD1 keeps the near wake (the arms fade to nothing at the outer
        // edge of LOD1, as they did at the old detail edge); beyond it
        // armFade 0 is a continuation, not a cut.
        // b4.2h: past the detail band the yards are not animated; swing the
        // (hidden) trim pivots with the LOD sails so the running rigging
        // drawn to 150 m stays made fast to where the yards are drawn.
        if (mesh.rigSet && mesh.lodLevel <= 2) {
          const yaw = THREE.MathUtils.clamp(mesh.lod2SailAngle, -1.15, 1.15);
          for (let p = 0; p < mesh.trimPivots.length; p++) mesh.trimPivots[p].rotation.y = yaw;
          updateRigging(mesh.rigging);
        }
        const lod1Wake = mesh.lodLevel <= 1;
        if (lod1Wake) {
          // LOD1 keeps the breaches readable (hole-vis on the root, no inboard).
          this.holeMarkerMat.opacity = 0.28 + 0.24 * (0.5 + 0.5 * Math.sin(t * 3.4));
          this.syncHoleVis(mesh, ship, t, false);
        }
        this.updateWake(mesh, ship, stats, waveT, dt, lod1Wake, storm01,
          lod1Wake ? THREE.MathUtils.clamp((1 - distSq / (detailDistance * detailDistance)) * 4, 0, 1) : 0);
        continue;
      }
      // ── THE WHEEL SHOWS THE RUDDER, NOT THE SPIN ────────────────────────
      // It used to integrate yaw RATE: a helmsman at anchor hauling the wheel
      // hard over saw nothing move, and a ram that spun the hull span the wheel
      // like a slot machine with nobody on it. Ship.rudderAngle is already on
      // the wire (PhysicsSystem.applyShipRudderSteering slews it), so the hero
      // object in front of the captain reads the thing he is actually
      // commanding: three quarter-turns lock to lock (ships-12).
      const rudderAngle = Number.isFinite(ship.rudderAngle) ? (ship.rudderAngle ?? 0) : 0;
      const rudder01 = THREE.MathUtils.clamp(rudderAngle / SHIP.RUDDER_MAX_ANGLE, -1, 1);
      const helmAlpha = wheelFollowAlpha(dt); // b4.3d: WHEEL_TAU_S lag behind the rudder
      mesh.wheel.rotation.z = THREE.MathUtils.lerp(
        mesh.wheel.rotation.z, helmWheelRotZ(rudder01), helmAlpha,
      );
      mesh.rudderPivot.rotation.y = THREE.MathUtils.lerp(mesh.rudderPivot.rotation.y, rudderAngle, helmAlpha);
      mesh.compassNeedle.rotation.y = -mesh.root.rotation.y;

      const anchorRaiseProgress = THREE.MathUtils.clamp(ship.anchorRaiseProgress ?? 0, 0, 1);
      const anchorDrop = ship.anchored ? 1 - anchorRaiseProgress : 0;
      // b4.3d: the drum turns with the cable only (+Y raise, fast reverse on the drop, still at rest).
      mesh.anchorCapstan.rotation.y += shipMotionOf(mesh).capstan.step(ship.anchored, anchorRaiseProgress, dt);
      const anchorAlpha = 1 - Math.exp(-10 * dt);
      // A DROPPED ANCHOR IS IN THE WATER. The descent was a fixed 2.75 m from
      // H + 0.34, which on the galleon (H 3.5) left the stock a metre ABOVE the
      // sea with the capstan spinning and the ship stopped (ships-11). Drop far
      // enough that the flukes are under: cathead height, plus the draft, plus
      // 0.6 m of margin.
      const anchorFall = SHIP_STATS[ship.type].height + 0.34 + mesh.hullProfile.draft + 0.6;
      mesh.anchor.position.y = THREE.MathUtils.lerp(
        mesh.anchor.position.y,
        SHIP_STATS[ship.type].height + 0.34 - anchorDrop * anchorFall,
        anchorAlpha,
      );
      mesh.anchor.rotation.z = THREE.MathUtils.lerp(mesh.anchor.rotation.z, ship.anchored ? 0.1 * anchorDrop : 0, anchorAlpha);
      // Chain hangs from windlass drum (child of windlass); only length changes
      // Chain pays out with the fall it now has to cover (0.76 was tuned for the
      // old 2.75 m), or the anchor swims away from the end of it.
      const chainPayout = 0.76 * (anchorFall / 2.75);
      mesh.anchorChain.scale.y = THREE.MathUtils.lerp(mesh.anchorChain.scale.y, ship.anchored ? 0.52 + anchorDrop * chainPayout : 0.52, anchorAlpha);

      // A FOUNDERING HULL IS DRAWN WHERE THE SERVER SANK HER (review-4 P0).
      //
      // These two lines used to be a client-only capsize: rotation.z was
      // OVERWRITTEN with `sinkProgress * PI * 0.42` (0.79 rad at 60% of
      // SINK_TIME, 1.32 at the end) and position.y with `ship.position.y -
      // sinkProgress * 5`. They were written when the server had an
      // `attitudeDecay` and no founder scene. SINK-01 slice b deleted that and
      // gave the server a real one: beginFounder freezes the flood list,
      // PhysicsSystem chases the list she actually took (±0.35 rad), and the
      // descent profile puts her weather deck under at 0.6·SINK_TIME. Match's
      // updateFounderingCrew keeps every hand aboard until HIS OWN plank is
      // under, so for the first twelve seconds of a twenty-second founder the
      // crew were standing on a deck drawn 45° over and three metres below
      // where the server was seating them. Nothing here now that the wire has
      // not sent: the same expressions as the alive branch, just chased faster
      // because a founder's attitude moves faster than a swell.
      const attitudeAlpha = 1 - Math.exp(-(ship.sinking ? 8 : 3.8) * dt);
      mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, basePitch, attitudeAlpha);
      mesh.root.rotation.z = THREE.MathUtils.lerp(
        mesh.root.rotation.z, baseRoll, 1 - Math.exp(-(ship.sinking ? 8 : 3.4) * dt),
      );

      // Sail state — keep canvas mostly vertical so it stays visible; tear is subtle
      const rawInt = ship.sailIntegrity ?? 1;
      const sailIntegrity = Number.isFinite(rawInt) ? Math.max(0, Math.min(1, rawInt)) : 1;
      // chainshottedUntil is in server sim seconds; `t` is the server-synced wave clock
      const chainshotted = t < ship.chainshottedUntil;
      const tornPitch = (1 - sailIntegrity) * 0.52 + (chainshotted ? 0.12 : 0);
      const sailAlpha = 1 - Math.exp(-11 * dt);
      // Round-2 field, read defensively: sails luff (flap, depowered) when pointed
      // into the no-go cone. Force the canvas slack so the cloth flutter goes hard.
      const luffing = !!(ship as Ship & { luffing?: boolean }).luffing;
      // b4.2f: the local helmsman's FIRST-PERSON eye (within 1.6 m of the
      // helm, aft of the wheel) sees the courses at HELM_COURSE_FADE; every
      // other camera, and every other player, sees them solid.
      let helmView = false;
      if (localCrewShip && cameraPosition) {
        const hz = -SHIP_STATS[ship.type].length * 0.315 - 0.5;
        const c = Math.cos(ship.rotation), sn = Math.sin(ship.rotation);
        const hx = ship.position.x + hz * sn, hzw = ship.position.z + hz * c;
        helmView = (cameraPosition.x - hx) ** 2 + (cameraPosition.z - hzw) ** 2 < 1.6 * 1.6;
      }
      // The wind the canvas FEELS (true wind minus the hull's own way): the
      // sail cloth fill and the masthead flag below both read it.
      const apparent = apparentWindLocal(
        wind.direction, wind.strength, ship.rotation, ship.velocity.x, ship.velocity.z, this.apparentWind,
      );
      const clothWind01 = sailWind01(apparent.speed);
      for (let s = 0; s < mesh.sails.length; s++) {
        const sail = mesh.sails[s];
        const rigKind = sail.userData.rigKind as RigSailKind | undefined;
        // The topsail goes away first; course, spanker and jib follow sailHeight.
        const kindHeight = rigKind ? sailHoistFor(rigKind, ship.sailHeight) : ship.sailHeight;
        sail.visible = kindHeight > SAIL_FURL_THRESHOLD;
        if (rigKind === 'course') {
          const cm = sail.material as THREE.MeshStandardMaterial;
          const target = helmView ? HELM_COURSE_FADE : 1;
          cm.opacity = Math.abs(cm.opacity - target) < 0.01 ? target : THREE.MathUtils.lerp(cm.opacity, target, 1 - Math.exp(-6 * dt));
          const see = cm.opacity < 0.999;
          if (see !== cm.transparent) { cm.transparent = see; cm.depthWrite = !see; cm.needsUpdate = true; }
        }
        const signedRelative = angleWrap(wind.direction - ship.rotation);
        // The ONE shared brace catch (shared/sailing.ts) so the luff/billow
        // visuals agree with the authoritative sail power.
        const rawTrimCatch = braceCatch(ship.sailAngle, signedRelative);
        const trimCatch = luffing ? Math.min(rawTrimCatch, 0.08) : rawTrimCatch;
        const phaseSeed = typeof sail.userData.phaseSeed === 'number' ? sail.userData.phaseSeed : sail.position.z;
        // Jibs and other stay-sails have a fixed yaw (centerline of the ship).
        // Square sails brace their whole trim pivot (yard + canvas + furled roll).
        const fixedYaw = sail.userData.fixedYaw;
        const trimPivot = sail.userData.trimPivot as THREE.Group | undefined;
        const targetSailYaw = typeof fixedYaw === 'number' ? fixedYaw : ship.sailAngle;
        const targetSailPitch = tornPitch * (0.55 + 0.15 * Math.sin(t * 0.9 + phaseSeed * 0.2));
        const deployedHeight = Math.max(0.06, kindHeight * Math.max(0.22, sailIntegrity));
        const hoistTopY = typeof sail.userData.hoistTopY === 'number' ? sail.userData.hoistTopY : sail.position.y;
        const hoistHeight = typeof sail.userData.hoistHeight === 'number' ? sail.userData.hoistHeight : 1;
        const hoistCentered = sail.userData.hoistCentered !== false;
        const targetSailY = hoistTopY - hoistHeight * deployedHeight * (hoistCentered ? 0.5 : 1);
        if (trimPivot) {
          // Clamp the visible brace angle — gameplay trim can reach ±86° but a
          // yard braced past ~65° reads broken. The full value still drives physics.
          const visualTrim = THREE.MathUtils.clamp(targetSailYaw, -1.15, 1.15);
          trimPivot.rotation.y += angleWrap(visualTrim - trimPivot.rotation.y) * sailAlpha;
        } else {
          sail.rotation.y += angleWrap(targetSailYaw - sail.rotation.y) * sailAlpha;
        }
        sail.rotation.x = THREE.MathUtils.lerp(sail.rotation.x, targetSailPitch, sailAlpha);
        const cloth = sail.userData.sailCloth as SailClothUniforms | undefined;
        if (cloth) {
          // b4.2g GPU cloth (ship/sailCloth.ts): the belly is signed by the
          // apparent wind against the DRAWN brace (taken aback = wind on the
          // forward face, belly aft), chased at SAIL_FILL_RATE; the hoist
          // gathers the cloth under the yard in the shader, so the mesh never
          // moves or squashes; chainshot damage cuts holes from sailIntegrity.
          const sailYaw = trimPivot ? trimPivot.rotation.y : sail.rotation.y;
          const fillTarget = sailFillTarget(apparent.localYaw, apparent.speed, sailYaw, trimCatch, luffing);
          const fill = stepSailFill(sail.userData.clothFill as number, fillTarget, dt);
          sail.userData.clothFill = fill;
          const prevHoist = typeof sail.userData.clothHoist === 'number' ? sail.userData.clothHoist : deployedHeight;
          const hoist = Math.abs(prevHoist - deployedHeight) < 1e-4 ? deployedHeight : THREE.MathUtils.lerp(prevHoist, deployedHeight, sailAlpha);
          sail.userData.clothHoist = hoist;
          if (sail.visible) {
            setSailClothUniforms(cloth, fill, sailLuff01(fill, luffing), hoist, t, clothWind01, sailIntegrity);
            const trim = sail.userData.swiftTrim as THREE.Object3D | null;
            if (trim && trim.visible) {
              // Swift-sail paint rides the gathered cloth: top pinned at the
              // yard, pushed out to the belly's mean depth.
              trim.scale.y = hoist;
              trim.position.y = hoistHeight * 0.5 * (1 - hoist);
              trim.position.z = fill * SAIL_BELLY * cloth.uCloth1.value.w * hoist * 0.5;
            }
          }
        } else {
          sail.position.y = THREE.MathUtils.lerp(sail.position.y, targetSailY, sailAlpha);
          sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, deployedHeight, sailAlpha);
          // Stay sails (jib, spanker) keep a scale.z belly, now steady and
          // driven by the apparent wind and the trim, not a 5 s breathing clock.
          const billow = (0.06 + 0.2 * trimCatch * clothWind01) * kindHeight * sailIntegrity;
          sail.scale.z = THREE.MathUtils.lerp(sail.scale.z, 1 + billow, sailAlpha);
          if (sail.visible) {
            // A leech shiver keeps the stay sail alive, stronger when
            // depowered and hardest when luffing.
            const shiver = luffing ? 0.055 : 0.012 + (1 - trimCatch) * 0.028;
            const freq = luffing ? 13.5 : 7.4;
            sail.rotation.z = Math.sin(t * freq + phaseSeed * 0.5) * shiver * ship.sailHeight;
          }
        }
      }
      // The yards have just been braced for this frame; re-seat every rope that
      // is made fast to one (ships-16). No-op when the trim did not move, and
      // allocation-free when it did.
      updateRigging(mesh.rigging);
      for (let f = 0; f < mesh.furledSails.length; f++) {
        const furled = mesh.furledSails[f];
        const furledKind = furled.userData.rigKind as RigSailKind | undefined;
        furled.visible = (furledKind ? sailHoistFor(furledKind, ship.sailHeight) : ship.sailHeight) <= SAIL_FURL_THRESHOLD;
        const furledSeed = typeof furled.userData.phaseSeed === 'number' ? furled.userData.phaseSeed : furled.position.z;
        furled.scale.setScalar(0.88 + Math.sin(t * 0.9 + furledSeed) * 0.015);
      }

      // Masthead flag: stream DOWNWIND OF THE APPARENT WIND off the pivot's +X
      // (animations-06: PI/2 + yaw pointed it exactly upwind), hang slack when
      // a run at the wind's own speed kills the apparent wind, and ripple
      // harder the faster you sail and the worse the weather. Phase is per-ship
      // (id hash), so a fleet never flutters in unison.
      const flagYaw = flagPivotYaw(apparent.localYaw);
      const slack = flagSlack(apparent.speed);
      mesh.flag.pivot.rotation.y = flagYaw;
      mesh.flag.pivot.rotation.z = -slack * FLAG_MAX_DROOP;
      const flagSpeed01 = Math.min(1, Math.hypot(ship.velocity.x, ship.velocity.z) / 9);
      mesh.flag.uniforms.uFlagTime.value = t;
      // Even becalmed at anchor the cloth breathes (0.012 m) — a dead-still flag
      // is what made it read as a painted board.
      mesh.flag.uniforms.uFlagWave.value.x =
        (0.012 + wind.strength * 0.032 + flagSpeed01 * 0.030 + storm01 * 0.055) * (1 - slack * 0.7);

      for (let p = 0; p < mesh.pennants.length; p++) {
        const pennant = mesh.pennants[p];
        pennant.rotation.y = flagYaw;
        pennant.rotation.z = Math.sin(t * 8 + pennant.position.z * 0.14) * 0.12 * (1 - slack) - slack * FLAG_MAX_DROOP;
        pennant.scale.x = 1.05 + wind.strength * 0.65 + Math.min(0.4, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.03);
      }
      const pennantTypes = this.upgradePennantTypes
        ??= Object.keys(mesh.upgradePennants) as ShipUpgradeType[];
      for (const type of pennantTypes) {
        const pennant = mesh.upgradePennants[type];
        pennant.visible = activeUpgrades.has(type);
        if (!pennant.visible) continue;
        pennant.rotation.y = flagYaw;
        pennant.rotation.z = Math.sin(t * 9.5 + pennant.position.y * 0.3) * 0.18 * (1 - slack) - slack * FLAG_MAX_DROOP;
        pennant.scale.x = 1.1 + wind.strength * 0.55 + Math.min(0.35, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.025);
      }

      const cannonsPerSide = Math.max(1, SHIP_STATS[ship.type].cannonCount / 2);
      const shipOperators = cannonOperators.get(ship.id);
      const objMotion = shipMotionOf(mesh); // b4.3d: fire edges -> recoil + gunport lids
      objMotion.update(ship.cannonCooldowns, (i) => !!shipOperators?.[i], t, dt);
      for (let index = 0; index < mesh.cannonMeshes.length; index++) {
        const cannon = mesh.cannonMeshes[index];
        const operator = shipOperators?.[index];
        if (!detailNear) {
          cannon.root.visible = true;
          continue;
        }
        const localOperatorUsingThisCannon = !!operator && operator.id === localPlayerId;
        const tooCloseToCamera = localOperatorUsingThisCannon
          && !!cameraPosition
          && cannon.root.getWorldPosition(this.tempCannonPos).distanceToSquared(cameraPosition) < 1.35 * 1.35;
        cannon.root.visible = !tooCloseToCamera;
        const broadsideYaw = ship.rotation + (index < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
        const desiredYaw = operator ? angleWrap(operator.rotation.x - broadsideYaw) : 0;
        const desiredPitch = operator ? operator.rotation.y : 0;
        const cannonAlpha = 1 - Math.exp(-18 * dt);
        objMotion.aimGun(index, cannon, desiredYaw, desiredPitch, cannonAlpha);
      }

      // Ship lanterns: warm glass emissive ramps day→night (setNightFactor). At
      // night the nearest few ships also get one real PointLight with fast noise
      // flicker (deliberately NOT a smooth sine — reads like a real flame).
      for (let g = 0; g < mesh.lanternGlassMats.length; g++) mesh.lanternGlassMats[g].emissiveIntensity = lanternEmissive;
      if (mesh.nightLight) {
        const wantLight = this.nightFactor > 0.02 && nightLightIds.has(ship.id);
        mesh.nightLight.visible = wantLight;
        if (wantLight) {
          const seed = ship.id.charCodeAt(0) * 1.37 + ship.id.charCodeAt(ship.id.length - 1) * 0.53;
          const flicker = 0.8 + 0.2 * this.flickerNoise(t * 9 + seed);
          // Your own deck has to be readable at night, so the crew's hull gets a
          // brighter lantern than the silhouettes on the horizon do.
          const own = !!localPlayerId && ship.crewIds.includes(localPlayerId);
          mesh.nightLight.intensity = this.nightFactor * (own ? 4.2 : 2.6) * flicker;
        } else {
          mesh.nightLight.intensity = 0;
        }
      }

      // Animated foam wake ribbon + Kelvin wedge + bow spray, tracking the
      // Gerstner surface. The wedge is full strength inside 86% of the detail
      // range (distSq is 75% of the square there) and linear to nothing at the
      // edge of it, so it is already zero-area when the far path takes over.
      const armFade = THREE.MathUtils.clamp(
        (1 - distSq / (detailDistance * detailDistance)) * 4, 0, 1,
      );
      this.updateWake(mesh, ship, stats, waveT, dt, true, storm01, armFade);

      // Shared pulse for every hole halo (one material, breathing in sync).
      this.holeMarkerMat.opacity = 0.28 + 0.24 * (0.5 + 0.5 * Math.sin(t * 3.4));
      this.breachFxUniforms.uTime.value = t;
      this.breachFxUniforms.uDay.value = 1 - 0.85 * this.nightFactor;
      const breachNear = distSq < BREACH_INBOARD_DIST_SQ;
      let openBreaches = 0;
      // Breaches are ENTITIES: diff the wire list against the decals we already
      // built, keyed by ShipHole.id. A new id spawns a decal exactly where the
      // shot landed; a patched flip swaps it for crossed planks at the SAME
      // point; a vanished id disposes. No count heuristics, so a re-punched
      // spot can never end up with a plank floating over an open hole.
      openBreaches = this.syncHoleVis(mesh, ship, t, breachNear);

      // Hold cargo: the crew's banked gold, standing up in the hold as crates and
      // coin. One tier variant visible at a time (cumulative geometry), so the
      // stack GROWS as they bank and empties the moment a boarder cuts it out of
      // them. This is the only place in the game where "who is winning" is a
      // question you answer by looking at a ship instead of reading a number.
      // b2-device-04: a sealed far hull skips its hold (see HOLD_INTERIOR_DIST_SQ).
      const holdShown = !cameraPosition || localCrewShip || openBreaches > 0 || ship.sinking
        || distSq < HOLD_INTERIOR_DIST_SQ;
      if (holdShown !== mesh.holdInteriorShown) {
        mesh.holdInteriorShown = holdShown;
        for (let i = 0; i < mesh.holdInterior.length; i += 1) mesh.holdInterior[i].visible = holdShown;
      }
      if (mesh.holdCargoTiers.length > 0) {
        const tier = ship.sinking ? 0 : cargoTier(ship.cargoGold ?? 0);
        for (let i = 0; i < mesh.holdCargoTiers.length; i += 1) {
          mesh.holdCargoTiers[i].visible = i === tier - 1;
        }
      }

      // Hold water (b2.3a): the fill table sets the height (full exactly at
      // 1.0), the DRAWN attitude tilts it world-level, the client slosh
      // re-sim adds the dynamic slope. Foundering keeps it full.
      if (mesh.holdWater) {
        const dbg = this.holdWaterDebug;
        if (dbg) {
          if (dbg.roll !== undefined) mesh.root.rotation.z = dbg.roll;
          if (dbg.pitch !== undefined) mesh.root.rotation.x = dbg.pitch;
          // Freeze the drawn hull where the pin found it, so a probe camera
          // parked in the hold is not heaved out through the deck by the swell.
          const held = this.holdWaterDebugHeld.get(ship.id);
          if (held) { mesh.root.position.copy(held.pos); mesh.root.rotation.y = held.yaw; }
          else this.holdWaterDebugHeld.set(ship.id, { pos: mesh.root.position.clone(), yaw: mesh.root.rotation.y });
        }
        const level = dbg ? dbg.fill : THREE.MathUtils.clamp(
          (ship as unknown as { waterLevel?: number }).waterLevel ?? 0, 0, 1,
        );
        updateHoldWater(mesh.holdWater, {
          fill: ship.sinking ? 1 : level,
          roll: mesh.root.rotation.z,
          pitch: mesh.root.rotation.x,
          t,
          dt,
          sinking: !!ship.sinking,
          night: this.nightFactor,
        });
      }

      // Fire visual
      if (ship.onFire && !mesh.fireParticles) {
        mesh.fireParticles = this.createFireParticles();
        mesh.root.add(mesh.fireParticles);
      }
      if (!ship.onFire && mesh.fireParticles) {
        mesh.root.remove(mesh.fireParticles);
        mesh.fireParticles = null;
      }
      if (mesh.fireParticles && detailNear) {
        (mesh.fireParticles.material as THREE.PointsMaterial).size = 0.32 + Math.sin(t * 5) * 0.1;
        const positions = (mesh.fireParticles.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
        for (let i = 1; i < positions.length; i += 3) {
          positions[i] += 0.05;
          if (positions[i] > 6) positions[i] = 1;
        }
        (mesh.fireParticles.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      }
    }

    this.syncGangways(ships);
  }

  private createShipWake(): ShipWake {
    const group = new THREE.Group();
    group.name = 'ship-wake';

    // Stern ribbon + Kelvin arms + bow sheets, in one geometry and one draw.
    // The low tier gets the stern ribbon alone, exactly as before this lane.
    const surface = buildWakeSurface(this.quality);

    const material = new THREE.MeshBasicMaterial({
      map: this.foamTex.clone(), // per-ship clone so scroll offsets don't fight
      color: 0xcfe9f5,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    material.map!.needsUpdate = true;

    const ribbon = new THREE.Mesh(surface.geometry, material);
    ribbon.renderOrder = 2;
    // A WORLD-SPACE ribbon WITH A BOUNDING SPHERE, not an unculled one.
    //
    // The positions written by writeWakeSurface are absolute world coordinates
    // and the ribbon hangs off the scene at the origin, so three's computed
    // bounds are meaningless the moment the hull moves — which is why this said
    // `frustumCulled = false`. But "the bounds are stale" is an argument for
    // MAINTAINING them, not for abolishing the test: every hull in the match
    // that was foaming submitted its ribbon on every frame, whatever the camera
    // was pointed at. Measured on the world-fidelity understory view (low tier,
    // seed 20260801, a camera one metre off the ground looking at a bush): 16 of
    // the frame's 135 draws were wakes of hulls that were not in shot at all.
    // updateWake now writes a sphere around the hull and its tail after every
    // writeWakeSurface — one Vector3 set and one float, no allocation — so the
    // ribbon is culled by the same rule as everything else.
    ribbon.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    group.add(ribbon);

    // Bow-spray sprite pool
    const spray: WakeSpray[] = [];
    for (let i = 0; i < 8; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.sprayTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.visible = false;
      group.add(sprite);
      spray.push({ sprite, velocity: new THREE.Vector3(), life: 0, maxLife: 0.7 });
    }

    group.visible = false;
    return { group, ribbon, surface, material, spray, sprayCursor: 0, sprayTimer: 0, scroll: 0 };
  }

  /** Boarding planks: a berthed hull drops a gangway to the dock deck, so
   *  stepping aboard a galleon is a walk up a plank instead of a 2 m climb.
   *  Geometry comes from the SHARED getShipGangwayPlan — the same call the
   *  server's walkable strip uses, so the plank you see is the plank you walk.
   *  Scene-level and pooled: planks bridge two bodies, so they must not inherit
   *  the hull's pitch/roll, and berths come and go as ships anchor. */
  private syncGangways(ships: Ship[]) {
    if (this.docks.length === 0 && this.gangwayPlanks.length === 0) return;
    let used = 0;
    for (const dock of this.docks) {
      // A plank can only exist when the hull is lying against this berth, and
      // the shared planner allocates eight objects working that out. Every
      // dock x ship pair was being asked, every frame, so nine hulls anchored
      // elsewhere on the map paid for the one alongside. The bound is the dock's
      // own half-diagonal plus the longest hull plus the maximum span — a pair
      // outside it cannot produce a plan, so this rejects nothing real.
      const dockReach = Math.hypot(dock.width, dock.length) * 0.5 + GANGWAY_REJECT_MARGIN;
      for (let shipIndex = 0; shipIndex < ships.length; shipIndex++) {
        const ship = ships[shipIndex];
        if (!ship.anchored || ship.sinking || ship.alive === false) continue;
        const berthDx = ship.position.x - dock.position.x;
        const berthDz = ship.position.z - dock.position.z;
        if (berthDx * berthDx + berthDz * berthDz > dockReach * dockReach) continue;
        const plan = getShipGangwayPlan(ship, dock);
        if (!plan) continue;
        const plank = this.getGangwayPlank(used++);
        const dx = plan.dockEnd.x - plan.shipEnd.x;
        const dz = plan.dockEnd.z - plan.shipEnd.z;
        const dy = plan.dockEnd.y - plan.shipEnd.y;
        const run = Math.hypot(dx, dz);
        const len = Math.hypot(run, dy);
        plank.visible = true;
        plank.position.set(
          (plan.shipEnd.x + plan.dockEnd.x) * 0.5,
          (plan.shipEnd.y + plan.dockEnd.y) * 0.5,
          (plan.shipEnd.z + plan.dockEnd.z) * 0.5,
        );
        plank.rotation.set(0, Math.atan2(dx, dz), 0);
        // Tilt along the run so both ends land on their decks.
        plank.rotation.x = -Math.atan2(dy, Math.max(0.001, run));
        plank.scale.set(plan.halfWidth / 0.55, 1, len);
      }
    }
    for (let i = used; i < this.gangwayPlanks.length; i++) this.gangwayPlanks[i].visible = false;
  }

  /** One pooled plank: a 1 m-long unit board (scaled to the span) with cleats
   *  and a rope side-line, so it reads as ship's gear rather than a ramp decal. */
  private getGangwayPlank(index: number): THREE.Group {
    const existing = this.gangwayPlanks[index];
    if (existing) return existing;
    if (!this.gangwayMat) {
      this.gangwayMat = new THREE.MeshStandardMaterial({ map: this.deckTex, roughness: 0.95, metalness: 0 });
    }
    const g = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.09, 1), this.gangwayMat);
    board.receiveShadow = true;
    board.castShadow = true;
    g.add(board);
    // Anti-slip cleats across the plank (at unit-Z fractions, so they stay
    // evenly spaced whatever span the plank is scaled to).
    const cleatMat = new THREE.MeshStandardMaterial({ color: 0x3a2a16, roughness: 1 });
    for (let i = 0; i < 5; i++) {
      const cleat = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.035, 0.045), cleatMat);
      cleat.position.set(0, 0.06, -0.4 + i * 0.2);
      g.add(cleat);
    }
    for (const sx of [-1, 1] as const) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 1), cleatMat);
      edge.position.set(sx * 0.56, 0.02, 0);
      g.add(edge);
    }
    this.scene.add(g);
    this.gangwayPlanks[index] = g;
    return g;
  }

  private updateWake(
    mesh: ShipMeshGroup,
    ship: Ship,
    stats: typeof SHIP_STATS[keyof typeof SHIP_STATS],
    waveT: number,
    dt: number,
    detailNear: boolean,
    storm = 0,
    /** 0..1 distance ramp for the Kelvin wedge; the caller drives it to 0
     *  BEFORE the hull leaves its detail range so the wedge never pops. */
    armFade = 0,
  ) {
    const wake = mesh.wake;
    const speed = Math.hypot(ship.velocity.x, ship.velocity.z);
    const speedFrac = THREE.MathUtils.clamp(speed / Math.max(stats.maxSpeed, 0.001), 0, 1);
    const foaming = ship.alive && !ship.sinking && speed > 0.4;
    const targetAlpha = foaming
      ? Math.min(0.85, Math.pow(Math.min(speed / (stats.maxSpeed * 0.2), 1), 0.6) * (0.35 + speedFrac * 0.5))
      : 0;
    wake.material.opacity = THREE.MathUtils.lerp(wake.material.opacity, targetAlpha, 1 - Math.exp(-3.5 * dt));

    let sprayAlive = false;
    for (const p of wake.spray) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.visible = false;
        continue;
      }
      sprayAlive = true;
      p.velocity.y -= 7.5 * dt;
      p.sprite.position.addScaledVector(p.velocity, dt);
      const age = 1 - p.life / p.maxLife;
      const scale = 0.45 + age * 1.6;
      p.sprite.scale.set(scale, scale * 0.8, 1);
      p.sprite.material.opacity = (p.life / p.maxLife) * 0.55;
    }

    wake.group.visible = wake.material.opacity > 0.02 || sprayAlive;
    if (!wake.group.visible) return;

    const W = stats.width;
    const L = stats.length;
    const yaw = mesh.root.rotation.y;
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const latX = Math.cos(yaw), latZ = -Math.sin(yaw);
    const sternX = mesh.root.position.x - fwdX * L * 0.46;
    const sternZ = mesh.root.position.z - fwdZ * L * 0.46;
    const wakeLen = L * (1.1 + speedFrac * 1.5);

    // The wedge only exists once she is really driving: a hull ghosting along
    // at a knot leaves a stern smear and nothing either side of the bow. Ramped,
    // not switched, and it scales the arm WIDTH — so at the bottom of the ramp
    // every arm triangle is degenerate and there is no frame on which an edge
    // appears. Below the floor the arms leave the draw range entirely.
    const speedRamp = THREE.MathUtils.smoothstep(speedFrac, 0.22, 0.62);
    const armFactor = wake.surface.hasArms ? armFade * speedRamp : 0;
    setArmsVisible(wake.surface, armFactor > ARM_FACTOR_FLOOR);

    const f = this.wakeFrame;
    f.sternX = sternX; f.sternZ = sternZ;
    f.bowX = mesh.root.position.x + fwdX * L * 0.5;
    f.bowZ = mesh.root.position.z + fwdZ * L * 0.5;
    f.fwdX = fwdX; f.fwdZ = fwdZ; f.latX = latX; f.latZ = latZ;
    f.width = W; f.length = L;
    f.speedFrac = speedFrac; f.waveT = waveT; f.storm = storm;
    f.armFactor = armFactor;
    writeWakeSurface(wake.surface, f);
    // The bounds that make the ribbon cullable (see createShipWake). Bow to the
    // end of the tail, plus a lateral allowance for the widest Kelvin arm and a
    // vertical one for the storm swell the ribbon rides. Deliberately generous:
    // a sphere that is too big costs a draw that was already being paid, a
    // sphere that is too small pops a wake off the screen.
    const tailX = sternX - fwdX * wakeLen;
    const tailZ = sternZ - fwdZ * wakeLen;
    const sphere = wake.ribbon.geometry.boundingSphere!;
    sphere.center.set((f.bowX + tailX) / 2, 0, (f.bowZ + tailZ) / 2);
    sphere.radius = Math.hypot(f.bowX - tailX, f.bowZ - tailZ) * 0.5 + W * 1.6 + 8;

    // Scroll foam toward the tail so blobs read as staying put in the water
    wake.scroll = (wake.scroll - (speed * dt) / Math.max(wakeLen, 1)) % 1;
    wake.material.map!.offset.y = wake.scroll;

    // Bow spray bursts once the ship is really driving
    if (detailNear && foaming && speedFrac > 0.4) {
      wake.sprayTimer -= dt;
      if (wake.sprayTimer <= 0) {
        wake.sprayTimer = 0.12 / (0.4 + speedFrac);
        const bowX = mesh.root.position.x + fwdX * L * 0.5;
        const bowZ = mesh.root.position.z + fwdZ * L * 0.5;
        const bowY = gerstnerHeight(bowX, bowZ, waveT, WAVE_PARAMS, storm) + 0.25;
        for (const side of [-1, 1] as const) {
          const p = wake.spray[wake.sprayCursor];
          wake.sprayCursor = (wake.sprayCursor + 1) % wake.spray.length;
          p.maxLife = 0.5 + Math.random() * 0.35;
          p.life = p.maxLife;
          p.sprite.visible = true;
          p.sprite.position.set(
            bowX + latX * side * W * 0.32,
            bowY,
            bowZ + latZ * side * W * 0.32,
          );
          p.velocity.set(
            latX * side * (1.1 + Math.random() * 1.2) + fwdX * speed * 0.35,
            1.7 + Math.random() * 1.3 + speedFrac,
            latZ * side * (1.1 + Math.random() * 1.2) + fwdZ * speed * 0.35,
          );
          p.sprite.scale.set(0.45, 0.36, 1);
          p.sprite.material.opacity = 0.55;
        }
      }
    }
  }

  /** Samples the shared (storm-aware) Gerstner field at bow/stern/port/starboard
   *  plus center to derive hull attitude coherent with the visible ocean. Clamps
   *  match the server's spring-damped attitude (±0.45 / ±0.55) so blending from
   *  stale server values into this fallback is seamless. */
  private computeWaveMotion(x: number, z: number, yaw: number, halfL: number, halfW: number, waveT: number, storm = 0) {
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const latX = Math.cos(yaw), latZ = -Math.sin(yaw);
    const hBow = gerstnerHeight(x + fwdX * halfL, z + fwdZ * halfL, waveT, WAVE_PARAMS, storm);
    const hStern = gerstnerHeight(x - fwdX * halfL, z - fwdZ * halfL, waveT, WAVE_PARAMS, storm);
    const hRight = gerstnerHeight(x + latX * halfW, z + latZ * halfW, waveT, WAVE_PARAMS, storm);
    const hLeft = gerstnerHeight(x - latX * halfW, z - latZ * halfW, waveT, WAVE_PARAMS, storm);
    const out = this.waveMotion;
    // rotation.x > 0 dips the bow (local +z), so pitch follows stern-minus-bow
    out.pitch = THREE.MathUtils.clamp(Math.atan2(hStern - hBow, 2 * halfL) * 0.85, -0.45, 0.45);
    out.roll = THREE.MathUtils.clamp(Math.atan2(hRight - hLeft, 2 * halfW) * 0.7, -0.55, 0.55);
    // Wave surface height at the hull center — the heave target the mesh should
    // ride when the server residual is stale or missing.
    out.surfaceY = gerstnerHeight(x, z, waveT, WAVE_PARAMS, storm);
    return out;
  }

  /** Cheap 1-D value noise in [0,1): smoothstep-interpolated hashes of the integer
   *  lattice. Used for lantern flame flicker — chaotic, not a periodic sine. */
  private flickerNoise(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    const hash = (n: number) => {
      const s = Math.sin(n * 127.1) * 43758.5453;
      return s - Math.floor(s);
    };
    return hash(i) * (1 - u) + hash(i + 1) * u;
  }

  /** Light budget: returns the ids of the nearest (up to 6) alive ships to the
   *  camera that should receive a real PointLight at night. Empty by day. */
  private pickNightLightShips(ships: Ship[], cam?: THREE.Vector3): Set<string> {
    const set = new Set<string>();
    if (this.nightFactor <= 0.02) return set;
    const alive = ships.filter((s) => s.alive);
    if (cam) {
      alive.sort((a, b) =>
        ((a.position.x - cam.x) ** 2 + (a.position.z - cam.z) ** 2) -
        ((b.position.x - cam.x) ** 2 + (b.position.z - cam.z) ** 2));
    }
    for (let i = 0; i < Math.min(6, alive.length); i++) set.add(alive[i].id);
    return set;
  }

  /** CPU cloth step (ship/sails.ts), staggered by this renderer's frame counter. */
  private createFireParticles(): THREE.Points {
    const count = 50;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 3.2;
      pos[i * 3 + 1] = Math.random() * 3.5 + 1;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xFF6600, size: 0.32, sizeAttenuation: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    return new THREE.Points(geo, mat);
  }

  /** The yard-attached rope runs on a hull, with the InstancedMesh they live in.
   *  Read by scripts/test-ship-rigging.mjs to grade a 60-degree brace (ships-16). */
  __riggingDynamic(shipId: string): Array<{ index: number; pivot: THREE.Group; local: THREE.Vector3; mesh: THREE.InstancedMesh }> {
    const rig = this.shipMeshes.get(shipId)?.rigging;
    if (!rig) return [];
    return rig.dynamic.map((d) => ({ index: d.index, pivot: d.pivot, local: d.local, mesh: rig.mesh }));
  }

  /** The whole rigging record for a hull. scripts/test-ship-rigging.mjs drives
   *  updateRigging directly with it to measure the re-seat in isolation. */
  __rigging(shipId: string): Rigging | null {
    return this.shipMeshes.get(shipId)?.rigging ?? null;
  }

  /** b4.2h: the three rigging draws of a hull (scripts/test-ship-rigging.mjs). */
  __rigSet(shipId: string): RiggingSet | null {
    return this.shipMeshes.get(shipId)?.rigSet ?? null;
  }

  /** Hull-local Y of the sea on a given hull this frame — the wet line the
   *  planking shader darkens below. Read by scripts/test-ship-plank-shader.mjs
   *  to prove the uniform is live rather than frozen at its build-time zero. */
  getPlankWetLevel(shipId: string): number | null {
    return this.shipMeshes.get(shipId)?.plankUniforms.uWetY.value ?? null;
  }

  getShipGroup(shipId: string): THREE.Group | null {
    return this.shipMeshes.get(shipId)?.root ?? null;
  }

  /**
   * THE HULL AS DRAWN — for everything that has to stand on it.
   *
   * `ship.position` / `ship.rotation` are the SERVER's hull, and this renderer
   * does not draw that. It extrapolates the hull forward by the snapshot age,
   * adds the wave heave and the flood settle, and then EASES the mesh toward
   * that target with a 55ms time constant (`positionAlpha`, rate 18). So a
   * ship-local point resolved against the server transform is not a point on any
   * hull the player can see.
   *
   * The gap is not small and it is not constant. It is the easing lag, so it
   * scales with hull speed AND with frame length — the mesh closes a fixed
   * fraction of the remaining distance per frame, so a client at 3fps leaves it
   * open five times as wide as one at 60. Measured on the crew of a bot fleet:
   * 0.48m mean, 1.09m at p95, 9.66m worst. Nobody welded to a hull through
   * `ship.position` is standing where the planking is.
   *
   * Yaw and translation only. The hull also pitches and rolls; leaning the crew
   * with it is a separate decision from stopping them sliding along the deck,
   * and this is the one that has metres in it.
   *
   * @returns false when the hull has no mesh yet — the caller keeps the server
   *          transform for those frames, which is what every caller did
   *          unconditionally before this existed.
   */
  readRenderedHull(shipId: string, out: RenderedHullPose): boolean {
    const mesh = this.shipMeshes.get(shipId);
    if (!mesh) return false;
    out.x = mesh.root.position.x;
    out.y = mesh.root.position.y;
    out.z = mesh.root.position.z;
    // ATTITUDE, NOT JUST YAW (DECK-01). This used to return the yaw alone, with
    // a comment saying leaning the crew with the hull was "a separate decision".
    // It is not separate any more: mesh.root.rotation.x/z ARE the deck the crew
    // are drawn standing on, so anything welded to this hull reads all three.
    out.yaw = mesh.root.rotation.y;
    out.pitch = mesh.root.rotation.x;
    out.roll = mesh.root.rotation.z;
    return true;
  }

  /** Per-BREACH FX attach points on the REAL planking. Each open hole exposes
   *  an empty Object3D (child of the rendered ship, so its world transform
   *  follows heave/pitch/roll/list) oriented outward along the surface normal.
   *  Game.ts gates each one on the LIVE wave surface before jetting water, so
   *  a breach only gushes while it is genuinely under. */
  getHoleAnchors(shipId: string): Array<{ id: number; anchor: THREE.Object3D; active: boolean }> {
    const mesh = this.shipMeshes.get(shipId);
    if (!mesh) return [];
    const out: Array<{ id: number; anchor: THREE.Object3D; active: boolean }> = [];
    for (const [id, vis] of mesh.holeVis) {
      out.push({ id, anchor: vis.gush, active: !vis.patched });
    }
    return out;
  }

  getCannonWorldPos(shipId: string, cannonIndex: number): THREE.Vector3 | null {
    const mesh = this.shipMeshes.get(shipId);
    if (!mesh || cannonIndex >= mesh.cannonMeshes.length) return null;
    const pos = new THREE.Vector3();
    mesh.cannonMeshes[cannonIndex].root.getWorldPosition(pos);
    return pos;
  }
}
