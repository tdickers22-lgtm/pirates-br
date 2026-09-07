import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { IslandDock, Player, Ship, ShipHole, ShipUpgradeType, Vec2 } from '../../shared/types/index.js';
import { FLOODING, SHIP, SHIP_STATS } from '../../shared/constants/index.js';
import { sampleWind, angleWrap, getSailRopeStationLocals, getBraceStationLocals, getShipBoardingLadderLocals, getMainMastLocalZ, getCrowNestStandingY, getShipCompanionwayConfig, getShipQuarterdeckConfig, gerstnerHeight, getStormWaveIntensity, WAVE_PARAMS } from '../../shared/utils/index.js';
import { cargoTier } from '../../shared/cargo.js';
import { getAmmoCrateLocal, getCannonDeckLocalPosition, getShipGangwayPlan } from '../../shared/interactions.js';
// The hull loft lives in shared/ (ships-24 phase 1): the server stands crew on
// the same shape this renderer draws. scripts/test-hull-loft.mjs pins it.
import { getHullProfile, hullSurfacePointAt, stationSurfaceAt } from '../../shared/hull.js';
import type { HullProfile } from '../../shared/hull.js';
import type { RenderQuality } from './Renderer.js';
import { registerBudgetLight } from './LightBudget.js';
import { showWhenAffordable } from './FirstDrawBudget.js';

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
};


import { finishCanvasTexture, foamTexture, sailTexture, sprayTexture, supplyLidTexture, woodCanvas, woodTexture } from './ship/textures.js';
import type { SupplyKind } from './ship/textures.js';
import { makeBillowedSailGeometry, makeHullStrakeGeometry, makeLoftedHullGeometry, makeStairRampGeometry, makeWaterlineFoamGeometry, makeWaterlineFoamTexture, mergeStaticMeshes, NO_MERGE_EXCLUDE } from './ship/geometry.js';
import { applyFlagWave, FLAG_DROP, FLAG_FLY, flagPhaseFromId, flagTexture, makeBarrel, makeCylinderBetween, makeFigurehead, makeHatchGrating, makeLanternFixture, makeRopeCoil, makeWindowFrame } from './ship/dressing.js';
import type { FlagUniforms, ShipFlag } from './ship/dressing.js';
import { makeHoldCargoStacks, makeShipInterior } from './ship/interior.js';
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

/** Three quarter-turns of the helm from hard a-port to hard a-starboard. */
const WHEEL_TURNS_LOCK_TO_LOCK = 0.75;
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
function applyHullHoleDiscard(
  material: THREE.Material,
  holeUniform: { value: THREE.Vector4[] },
  slots: number,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHoles = holeUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHullPos;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vHullPos = (instanceMatrix * vec4(position, 1.0)).xyz;
#else
  vHullPos = position;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHullPos;\nuniform vec4 uHoles[${slots}];`)
      .replace('#include <map_fragment>', `for (int i = 0; i < ${slots}; i++) { if (uHoles[i].w > 0.0 && distance(vHullPos, uHoles[i].xyz) < uHoles[i].w) discard; }\n#include <map_fragment>`);
  };
  // A material whose program source changed must be recompiled, and two
  // materials that differ only by this patch must not share a program.
  material.customProgramCacheKey = () => `hull-hole-discard-${slots}`;
  material.needsUpdate = true;
}


interface CannonMeshGroup {
  root: THREE.Group;
  yawPivot: THREE.Group;
  pitchPivot: THREE.Group;
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
  positions: THREE.BufferAttribute;
  material: THREE.MeshBasicMaterial;
  spray: WakeSpray[];
  sprayCursor: number;
  sprayTimer: number;
  scroll: number;
}

const WAKE_ROWS = 9;
const WAKE_COLS = 3;
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
}

interface ShipMeshGroup {
  root: THREE.Group;
  detailRoot: THREE.Group;
  proxyRoot: THREE.Group;
  proxySails: THREE.Mesh[];
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
  cannonMeshes: CannonMeshGroup[];
  lanterns: THREE.PointLight[];
  wheel: THREE.Object3D;
  /** Rudder blade on its own stock: rotation.y is Ship.rudderAngle. */
  rudderPivot: THREE.Object3D;
  compassNeedle: THREE.Object3D;
  anchor: THREE.Group;
  anchorChain: THREE.Mesh;
  anchorCapstan: THREE.Group;
  /** Shared warm-amber glass materials whose emissiveIntensity ramps with night. */
  lanternGlassMats: THREE.MeshStandardMaterial[];
  /** One warm PointLight per ship (budgeted: only the nearest few get lit at night). */
  nightLight: THREE.PointLight | null;
  /** Dark water plane inside the hold, raised by (ship as any).waterLevel. */
  holdWater: THREE.Mesh | null;
  holdWaterBase: Float32Array | null;
  /** Cumulative cargo-stack variants, index 0 = tier 1 … index 3 = tier 4.
   *  Exactly one (or none) is visible; see ship.cargoGold. */
  holdCargoTiers: THREE.Object3D[];
  wake: ShipWake;
  /** vec4 (xyz = hull-local hole center, w = radius) driving the hull's
   *  fragment-discard breaches, one slot per UNPATCHED hole; radius 0 =
   *  inactive. MAX_HOLES_PER_SHIP slots — the server can never exceed it. */
  hullHoleUniform: { value: THREE.Vector4[] };
  /** Waterline contact collar (wet-edge foam hugging the hull's own waterline). */
  waterlineFoam: THREE.Mesh;
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

export class ShipRenderer {
  private shipMeshes: Map<string, ShipMeshGroup> = new Map();
  private scene!: THREE.Scene;
  private quality: RenderQuality = 'balanced';
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
  /** Shared breach-decal materials. Holes are spawned at runtime now (one per
   *  ShipHole entity, wherever the shot landed), so these live on the renderer
   *  instead of being rebuilt inside every hull. */
  private readonly holeMat = new THREE.MeshStandardMaterial({
    color: 0x07080a, roughness: 1, metalness: 0,
    emissive: 0x06243a, emissiveIntensity: 0.35,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  private readonly holeRimMat = new THREE.MeshStandardMaterial({
    color: 0x20120a, roughness: 0.95, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  private readonly splinterMat = new THREE.MeshStandardMaterial({
    color: 0x140b05, roughness: 1, side: THREE.DoubleSide,
  });
  /** Reused splinter-shard geometry, scaled per decal (all breaches render at
   *  HOLE_VISUAL_RADIUS — depth of damage reads as MORE holes, not bigger ones). */
  private holeDecalGeo: { opening: THREE.CircleGeometry; rim: THREE.RingGeometry; shards: THREE.BufferGeometry | null; marker: THREE.RingGeometry } | null = null;
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
  private plankPatchRimMat: THREE.MeshStandardMaterial | null = null;

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    this.scene = scene;
    this.quality = quality;
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
  setNightFactor(nf: number) {
    this.nightFactor = THREE.MathUtils.clamp(nf, 0, 1);
  }

  clear() {
    for (const mesh of this.shipMeshes.values()) {
      this.scene.remove(mesh.root);
      this.scene.remove(mesh.wake.group);
      // Dispose per-ship GPU buffers (lofted hulls, rigging, decals are unique
      // per ship) or every match restart leaks them all. Materials are mostly
      // shared palette/canvas singletons — leave those alive.
      for (const root of [mesh.root, mesh.wake.group]) {
        root.traverse((obj) => {
          const geo = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
          geo?.dispose?.();
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

  private buildShipProxy(
    ship: Ship,
    stats: typeof SHIP_STATS[keyof typeof SHIP_STATS],
    proxySails: THREE.Mesh[],
  ) {
    const W = stats.width;
    const L = stats.length;
    const H = stats.height;
    const group = new THREE.Group();
    group.name = 'ship-proxy';

    // Low-poly LOFT of the exact same silhouette as the detail hull (same
    // profile, fewer stations/slots) with the same painted-wale team texture —
    // crossing the detail distance no longer pops shape, draft or stripe.
    const profile = getHullProfile(ship.type);
    const hullMat = new THREE.MeshStandardMaterial({
      map: this.getTeamHullTexture(ship.teamColor),
      roughness: 0.85,
      metalness: 0.02,
    });
    hullMat.name = 'proxy-hull-shell';
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.95 });
    darkMat.name = 'proxy-timber';
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xeadfbf, roughness: 0.8, side: THREE.DoubleSide });
    sailMat.name = 'proxy-sail-canvas';

    const hull = new THREE.Mesh(makeLoftedHullGeometry(profile, true), hullMat);
    group.add(hull);

    // Deck slab top face matches the walkable plane (H + 0.1)
    const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.12, L * 0.72), darkMat);
    deck.position.y = H + 0.04;
    group.add(deck);

    // Stern castle + bowsprit so the far silhouette matches the detail model
    const castle = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, H * 0.28, L * 0.22), darkMat);
    castle.position.set(0, H + H * 0.14, -L * 0.37);
    group.add(castle);
    const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, L * 0.33, 5), darkMat);
    bowsprit.rotation.x = Math.PI * 0.5;
    bowsprit.rotation.z = -0.04;
    bowsprit.position.set(0, H + 0.48, L * 0.61);
    group.add(bowsprit);

    const mastCount = stats.mastCount;
    // Keep the aftmost mast forward of the stern helm so its sail never drapes
    // over the wheel (aftmost lands ~-L*0.14, wheel sits at -L*0.315).
    const mastSpacing = L * 0.42 / Math.max(mastCount - 1, 1);
    const mastStartZ = L * 0.28;
    for (let m = 0; m < mastCount; m++) {
      const mastZ = mastStartZ - m * mastSpacing;
      // Same mast height law as the detail model — no rig-height pop at the LOD line
      const mastH = H * (mastCount === 1 ? 3.6 : 3.1);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, mastH, 5), darkMat);
      mast.position.set(0, H + mastH * 0.5, mastZ);
      group.add(mast);

      const proxySailMat = m === 0 ? sailMat.clone() : sailMat;
      if (m === 0) proxySailMat.map = this.getTeamSailTexture(ship.teamColor);
      // ~12% smaller than the old proxy (tracks the detail-model sail shrink);
      // the aftmost mast narrows a further 10% — it's the helm's view blocker.
      const proxySailW = W * 0.92 * (mastCount > 1 && m === mastCount - 1 ? 0.9 : 1);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(proxySailW, H * 0.9), proxySailMat);
      sail.position.set(0, H + mastH * 0.58, mastZ);
      sail.rotation.order = 'YXZ';
      sail.rotation.x = 0.055; // slight billow tilt so the plane doesn't read flat
      group.add(sail);
      proxySails.push(sail);
    }

    // Flag keeps the saturated team color — it IS the team identity at range
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
    flag.position.set(0.38, H * 3.9, mastStartZ);
    group.add(flag);

    mergeStaticMeshes(group, new Set<THREE.Object3D>([...proxySails, flag]));

    return group;
  }

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
    };

    // ── Hull ─────────────────────────────────────────────────
    // Lofted shell: rounded bilge, tumblehome, flared raked bow, real draft.
    // Only the SHELL changed — deck plane, rails, cannon/mast positions and the
    // walkable footprint (sheer half-widths) are identical to the server tables.
    const profile = getHullProfile(ship.type);
    const hullGeo = makeLoftedHullGeometry(profile);
    // REAL see-through breaches: the fragment shader discards hull planking
    // inside each active hole (hull-local space — the loft mesh sits at
    // identity in the ship group, so `position` IS hull-local). The material
    // is DoubleSide, so looking through an opening shows the far interior
    // wall instead of vanished backfaces.
    const holeSlots = FLOODING.MAX_HOLES_PER_SHIP;
    const hullHoleUniform = { value: Array.from({ length: holeSlots }, () => new THREE.Vector4(0, 0, 0, 0)) };
    applyHullHoleDiscard(hullMat, hullHoleUniform, holeSlots);
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
    const waterlineFoam = new THREE.Mesh(
      makeWaterlineFoamGeometry(profile, Math.max(0.55, W * 0.16)),
      new THREE.MeshBasicMaterial({
        map: this.waterlineFoamTex,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    waterlineFoam.name = 'waterline-foam';
    waterlineFoam.renderOrder = 2;
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
    group.add(bowsprit);

    const figureheadMat = new THREE.MeshStandardMaterial({
      color: 0xc49235,
      roughness: 0.54,
      metalness: 0.45,
      emissive: 0x2a1500,
      emissiveIntensity: 0.08,
    });
    // Per-type carved figurehead at the stem, team accent on the fins/tail/eyes.
    const figurehead = makeFigurehead(ship.type, figureheadMat, teamAccentMat);
    figurehead.position.set(0, H * 0.72, L * 0.55);
    figurehead.rotation.x = -0.12;
    group.add(figurehead);

    // Transom panel nests within the lofted stern (the loft's own raked cap
    // carries the shape below) instead of the old full-beam slab.
    const sternTransom = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.64, H * 0.52, 0.14),
      darkMat,
    );
    sternTransom.position.set(0, H * 0.66, -L * 0.505);
    sternTransom.castShadow = true;
    sternTransom.receiveShadow = true;
    group.add(sternTransom);

    const bowCap = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.34, H * 0.18, 0.12),
      hullMat,
    );
    bowCap.position.set(0, H * 0.78, L * 0.49);
    bowCap.castShadow = true;
    group.add(bowCap);

    // External keel plank running under the new draft, plus a rudder blade
    // hung off the raked sternpost — the underwater body reads as a real hull.
    const keel = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.28, L * 0.68), darkMat);
    keel.position.set(0, -profile.draft + 0.05, -L * 0.02);
    group.add(keel);
    // The blade hangs off a STOCK it can turn on. It used to be merged into the
    // dark-timber bucket and never moved at all, while the wheel in front of the
    // captain span off yaw rate (ships-12). Pivot at the stern post, blade
    // translated aft of it, so rotation.y is the rudder angle on the wire.
    const rudderPivot = new THREE.Group();
    rudderPivot.name = 'rudder-stock';
    rudderPivot.position.set(0, -profile.draft * 0.42 + H * 0.06, -L * 0.44);
    const rudder = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, profile.draft * 0.85 + H * 0.2, L * 0.045).translate(0, 0, -L * 0.015),
      darkMat,
    );
    rudder.rotation.x = 0.1;
    rudderPivot.add(rudder);
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
    });
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
    );
    group.add(holdCargo.group);

    // ── Water-in-hull plane ──────────────────────────────────
    // Dark flooding water inside the hold, visible from above through the open
    // companionway / hatch grating. Hidden until ship.waterLevel > 0.02;
    // its Y rises with the flood level and a few verts ripple in update().
    // The plane is FITTED to the interior footprint: each z-row is scaled to
    // the loft's waterline half-width at that station, so the rising sheet
    // stays inside the hull silhouette instead of poking through the tapered
    // bow/stern planking. (Above local y=0 the hull only gets wider toward the
    // wale, so the waterline half-width is a safe inner bound at every fill.)
    const holdWaterGeo = new THREE.PlaneGeometry(1, 1, 6, 8);
    holdWaterGeo.rotateX(-Math.PI * 0.5);
    {
      const pos = holdWaterGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const zLocal = pos.getZ(i) * L * 0.9; // rows span ±0.45 L
        const half = Math.max(0.16, hullSurfacePointAt(profile, zLocal, 0).x * 0.92);
        pos.setX(i, pos.getX(i) * 2 * half); // ±0.5 → ±half at this station
        pos.setZ(i, zLocal);
      }
      pos.needsUpdate = true;
      holdWaterGeo.computeVertexNormals();
    }
    const holdWater = new THREE.Mesh(
      holdWaterGeo,
      new THREE.MeshStandardMaterial({
        color: 0x0a2028,
        roughness: 0.18,
        metalness: 0.35,
        emissive: 0x03141c,
        emissiveIntensity: 0.4,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    holdWater.position.set(0, 0.42, 0);
    holdWater.visible = false;
    holdWater.renderOrder = 1;
    const holdWaterBase = Float32Array.from(
      (holdWaterGeo.attributes.position as THREE.BufferAttribute).array as Float32Array,
    );
    group.add(holdWater);

    // ── Weather deck (split around stairwell — no hatch lids; open companionway like Sea of Thieves)

    // Weather deck: 4 box slabs around the stairwell so the hole is *real* geometry
    // (no fragile ShapeGeometry hole-punching). The bulwarks/rails added later hide
    // the rectangular outer edge.
    // Slab center such that the TOP face lands exactly on the server's standing
    // plane (ship.y + H + 0.1) — pirates stand ON the planks, not ankle-deep.
    const deckTopY = H + 0.025;
    const addDeckSlab = (cx: number, cz: number, bw: number, bd: number) => {
      if (bw <= 0.05 || bd <= 0.05) return;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.25, bw), 0.15, Math.max(0.25, bd)),
        deckMat,
      );
      slab.position.set(cx, deckTopY, cz);
      slab.receiveShadow = true;
      slab.castShadow = true;
      group.add(slab);
    };

    const zSternEdge = -halfDeckZ;
    const zBowEdge = halfDeckZ;
    const zHoleMin = holeCz - voidHalfZ;
    const zHoleMax = holeCz + voidHalfZ;
    const sternDepth = Math.max(0, zHoleMin - zSternEdge);
    if (sternDepth > 0) addDeckSlab(0, zSternEdge + sternDepth * 0.5, W * 0.95, sternDepth);
    const bowDepth = Math.max(0, zBowEdge - zHoleMax);
    if (bowDepth > 0) addDeckSlab(0, zHoleMax + bowDepth * 0.5, W * 0.95, bowDepth);

    const midDepth = Math.max(0, zHoleMax - zHoleMin);
    const xPortOuter = -W * 0.475;
    const xStarOuter = W * 0.475;
    const xHoleMin = holeCx - voidHalfX;
    const xHoleMax = holeCx + voidHalfX;
    const portMidW = Math.max(0, xHoleMin - xPortOuter);
    if (portMidW > 0 && midDepth > 0) addDeckSlab(xPortOuter + portMidW * 0.5, holeCz, portMidW, midDepth);
    const starMidW = Math.max(0, xStarOuter - xHoleMax);
    if (starMidW > 0 && midDepth > 0) addDeckSlab(xHoleMax + starMidW * 0.5, holeCz, starMidW, midDepth);

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
    addRail( W * 0.5 - railThick, 0, railThick * 2, L * 0.82);
    addRail(-W * 0.5 + railThick, 0, railThick * 2, L * 0.82);
    addRail(0, -L * 0.41, W * 0.95, railThick * 2);

    // Bulwarks keep the upper deck feeling like a proper enclosed ship instead of an open raft.
    const bulwarkH = 0.34;
    for (const sx of [-1, 1]) {
      const bulwark = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, bulwarkH, L * 0.78),
        deckMat,
      );
      bulwark.position.set(sx * (W * 0.44), H + bulwarkH * 0.5, 0);
      bulwark.castShadow = true;
      bulwark.receiveShadow = true;
      group.add(bulwark);
    }
    const bowBreastwork = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.72, bulwarkH, 0.16),
      deckMat,
    );
    bowBreastwork.position.set(0, H + bulwarkH * 0.5, L * 0.36);
    group.add(bowBreastwork);
    // Forward-quarter bulwark: the straight side run stops at z = 0.39·L while
    // the walk clamp reaches 0.46·L, so the last ~0.3 m of bow deck used to be
    // fenced by an invisible rail. Two short angled segments per side carry the
    // rail from the bulwark end in to the stem, staying OUTBOARD of the walk
    // taper (0.325·W at 0.39·L → 0.175·W at 0.46·L) the whole way.
    for (const sx of [-1, 1] as const) {
      const bowRun: Array<[number, number]> = [
        [W * 0.44, L * 0.39],
        [W * 0.345, L * 0.435],
        [W * 0.155, L * 0.472],
      ];
      for (let i = 0; i < bowRun.length - 1; i++) {
        const [x0, z0] = bowRun[i];
        const [x1, z1] = bowRun[i + 1];
        const dx = (x1 - x0) * sx;
        const dz = z1 - z0;
        const segLen = Math.hypot(dx, dz);
        const seg = new THREE.Mesh(new THREE.BoxGeometry(0.14, bulwarkH, segLen + 0.06), deckMat);
        seg.position.set(sx * (x0 + x1) * 0.5, H + bulwarkH * 0.5, (z0 + z1) * 0.5);
        seg.rotation.y = Math.atan2(dx, dz);
        seg.castShadow = true;
        seg.receiveShadow = true;
        group.add(seg);
        // Cap rail along the same run so the bow reads as one continuous rail.
        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, segLen + 0.06), darkTrimMat);
        cap.position.set(sx * (x0 + x1) * 0.5, H + bulwarkH + 0.05, (z0 + z1) * 0.5);
        cap.rotation.y = seg.rotation.y;
        cap.castShadow = true;
        group.add(cap);
      }
    }
    for (const sx of [-1, 1]) {
      const quarterBulwark = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, bulwarkH, L * 0.18),
        deckMat,
      );
      quarterBulwark.position.set(sx * (W * 0.33), H + bulwarkH * 0.5, -L * 0.31);
      group.add(quarterBulwark);
    }

    for (const sx of [-1, 1] as const) {
      // Ends at z = 0.39·L where the angled bow cap rail above picks it up —
      // the old 0.86·L run carried a straight rail out to 0.43·L, well outboard
      // of the hull's own sheer there (a rail hanging over open water).
      // darkTrimMat, not darkMat: the cap's outboard face is the same plane as
      // the side railing's — see the material's own note.
      const capRail = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.1, L * 0.82),
        darkTrimMat,
      );
      capRail.position.set(sx * W * 0.48, H + bulwarkH + 0.05, -L * 0.02);
      capRail.castShadow = true;
      group.add(capRail);
    }
    const sternCapRail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.1, 0.22), darkTrimMat);
    sternCapRail.position.set(0, H + bulwarkH + 0.05, -L * 0.42);
    sternCapRail.castShadow = true;
    group.add(sternCapRail);

    // Railing stanchions
    const stanchionCount = Math.max(4, Math.round(L / 3));
    for (let s = 0; s < stanchionCount; s++) {
      const sz = L * 0.41 - s * (L * 0.82 / stanchionCount);
      for (const sx of [-1, 1]) {
        const stanchion = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, railH, 6),
          darkMat,
        );
        stanchion.position.set(sx * (W * 0.5 - railThick), H + railH * 0.5, sz);
        group.add(stanchion);
      }
    }

    // Boarding ladders on both sides
    const ladderTop = H + 0.42;
    const ladderBottom = 0.35;
    const ladderHeight = ladderTop - ladderBottom;
    const ladderRopeMat = ropeCoilMat;
    const ladderRungMat = darkMat;
    for (const ladder of getShipBoardingLadderLocals(ship.type)) {
      for (const ropeOffset of [-0.14, 0.14]) {
        const rope = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.018, ladderHeight, 6),
          ladderRopeMat,
        );
        rope.position.set(ladder.x, ladderBottom + ladderHeight * 0.5, ladder.z + ropeOffset);
        group.add(rope);
      }
      for (let rung = 0; rung < 6; rung++) {
        const rungY = ladderBottom + 0.2 + rung * (ladderHeight - 0.4) / 5;
        const rungMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.022, 0.34, 6),
          ladderRungMat,
        );
        rungMesh.rotation.x = Math.PI * 0.5;
        rungMesh.position.set(ladder.x, rungY, ladder.z);
        group.add(rungMesh);
      }
    }

    // ── Stern castle ─────────────────────────────────────────
    const sternW = W * 0.88, sternH = H * 0.28, sternL = L * 0.22;
    const stern = new THREE.Mesh(new THREE.BoxGeometry(sternW, sternH, sternL), darkMat);
    stern.position.set(0, H + sternH * 0.5, -L * 0.37);
    stern.castShadow = true;
    group.add(stern);

    // Stern windows. Keep the glass on the aft face, with separate bars instead of
    // one solid brass rectangle covering the pane.
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x8fc7d8,
      roughness: 0.08,
      metalness: 0.15,
      emissive: 0x24465a,
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: 0.78,
    });
    const windowCount = Math.max(2, Math.round(W / 2.5));
    const sternFaceZ = -L * 0.51 - 0.085;
    for (let w = 0; w < windowCount; w++) {
      const wx = -sternW * 0.35 + w * (sternW * 0.7 / Math.max(windowCount - 1, 1));
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.05), windowMat);
      win.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.012);
      group.add(win);
      const winFrame = makeWindowFrame(0.5, 0.35, 0.055, 0.045, brassHardwareMat);
      winFrame.position.set(wx, H + sternH * 0.55, sternFaceZ - 0.04);
      group.add(winFrame);
    }

    const galleryRailY = H + sternH * 0.24;
    const galleryRail = new THREE.Group();
    galleryRail.position.set(0, galleryRailY, sternFaceZ - 0.16);
    const galleryTop = new THREE.Mesh(new THREE.BoxGeometry(sternW * 0.72, 0.06, 0.07), brassHardwareMat);
    galleryTop.position.y = 0.28;
    galleryRail.add(galleryTop);
    for (let p = 0; p < windowCount + 1; p++) {
      const px = -sternW * 0.36 + p * (sternW * 0.72 / windowCount);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.36, 6), brassHardwareMat);
      post.position.set(px, 0.1, 0);
      post.castShadow = true;
      galleryRail.add(post);
    }
    group.add(galleryRail);

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
      for (const t of [-0.36, 0, 0.36]) {
        const baluster = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.62, 5), darkMat);
        baluster.position.set(rx + Math.cos(rot) * t * rlen, H + qdRise + 0.31, rz + Math.sin(rot) * t * rlen);
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
    for (let spoke = 0; spoke < 8; spoke++) {
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

    // Bow anchors: seated against the visible topside. The loft tapers well
    // inboard of the deck box at the bow, so "flush" is governed by whichever
    // is prouder — the hull surface or the straight bulwark line. Arms run
    // fore-aft (y-rotated 90°) so the flukes lie flat along the planking.
    const anchorZ = L * 0.38;
    const anchorX = Math.max(
      hullSurfacePointAt(profile, anchorZ, H * 0.6).x + 0.05,
      W * 0.44 + 0.16,
    );
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
      const beamInnerX = W * 0.44 - 0.7;
      const beamOuterX = anchorX + 0.22;
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
    const ropeCoil = makeRopeCoil(ropeCoilMat, 0.3, 0.062, 3, 2.7);
    ropeCoil.position.set(-0.24, H + 0.1, L * 0.38);
    ropeCoil.rotation.y = 0.6;
    group.add(ropeCoil);

    // ── Masts ────────────────────────────────────────────────
    const sails: THREE.Mesh[] = [];
    const furledSails: THREE.Mesh[] = [];
    const pennants: THREE.Mesh[] = [];
    const trimPivots: THREE.Group[] = [];
    let nestFloorMesh: THREE.Mesh | undefined;
    const mastCount = stats.mastCount;
    // Keep the aftmost mast forward of the stern helm so its sail never drapes
    // over the wheel (aftmost lands ~-L*0.14, wheel sits at -L*0.315).
    const mastSpacing = L * 0.42 / Math.max(mastCount - 1, 1);
    const mastStartZ = L * 0.28;

    // All rigging collapses into two LineSegments draw calls (rope + ratline)
    // instead of ~50 individual Line objects per ship.
    const ropeSegmentPts: THREE.Vector3[] = [];
    const ratlineSegmentPts: THREE.Vector3[] = [];

    for (let m = 0; m < mastCount; m++) {
      const mastZ = mastStartZ - m * mastSpacing;
      const mastH = H * (mastCount === 1 ? 3.6 : 3.1);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);

      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(mastR * 0.8, mastR * 1.4, mastH, 16),
        darkMat,
      );
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
        const nestY = H + mastH * 0.86;
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

      // Boom / yardarm — lives inside a trim pivot together with its sail and
      // furled roll, so bracing the sails visibly swings the SPAR too instead
      // of the canvas rotating away from a frozen yard.
      // ~12% narrower than round-1 (1.2 base) so the helm can see forward past the rig
      const yardW = W * (1.06 - m * 0.1);
      const trimPivot = new THREE.Group();
      trimPivot.name = 'yard-trim-pivot';
      trimPivot.position.set(0, H + mastH * 0.82, mastZ);
      group.add(trimPivot);
      trimPivots.push(trimPivot);
      const yard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.042, yardW, 12),
        darkMat,
      );
      yard.rotation.z = Math.PI * 0.5;
      yard.castShadow = true;
      trimPivot.add(yard);

      // Rigging lines from yardarm to deck
      for (const sx of [-1, 1]) {
        ropeSegmentPts.push(
          new THREE.Vector3(sx * yardW * 0.48, H + mastH * 0.82, mastZ),
          new THREE.Vector3(sx * W * 0.44, H + 0.15, mastZ - L * 0.04),
        );
      }

      const addRigLine = (a: THREE.Vector3, b: THREE.Vector3) => {
        ratlineSegmentPts.push(a, b);
      };
      for (const sx of [-1, 1] as const) {
        const topA = new THREE.Vector3(sx * mastR * 1.8, H + mastH * 0.78, mastZ - L * 0.025);
        const topB = new THREE.Vector3(sx * mastR * 1.8, H + mastH * 0.72, mastZ + L * 0.025);
        const baseA = new THREE.Vector3(sx * W * 0.43, H + 0.42, mastZ - L * 0.09);
        const baseB = new THREE.Vector3(sx * W * 0.43, H + 0.42, mastZ + L * 0.08);
        addRigLine(topA, baseA);
        addRigLine(topB, baseB);
        const rungCount = 6;
        for (let rung = 1; rung < rungCount; rung++) {
          const tRung = rung / rungCount;
          addRigLine(
            new THREE.Vector3().lerpVectors(topA, baseA, tRung),
            new THREE.Vector3().lerpVectors(topB, baseB, tRung),
          );
        }
      }

      // Square-rigged sail — hangs from the yardarm. PlaneGeometry's default frame is
      // exactly what we want: width along X (matches yardarm direction), height along Y
      // (drops toward deck), normal along +Z (faces forward when "square" to wind).
      // The sail trim animation rotates around Y by `ship.sailAngle`.
      // The aftmost mast's canvas is what blocks the helm's forward view —
      // it narrows a further 10% on top of the global shrink.
      const sailW = yardW * 0.85 * (mastCount > 1 && m === mastCount - 1 ? 0.9 : 1);
      const sailH = mastH * 0.64;
      const sailGeo = makeBillowedSailGeometry(sailW, sailH, 10, 7);
      const mastSailMat = sailMat.clone();
      // Main sail carries the painted team band (team read at distance)
      if (m === 0) mastSailMat.map = this.getTeamSailTexture(ship.teamColor);
      const sail = new THREE.Mesh(sailGeo, mastSailMat);
      sail.rotation.order = 'YXZ';
      sail.rotation.y = 0;
      // Pivot-local frame: the pivot sits AT the yard, so hoist metadata is
      // relative to it (hoistTopY = 0 = the yard height).
      sail.position.set(0, -sailH * 0.375, 0);
      sail.userData.hoistTopY = 0;
      sail.userData.hoistHeight = sailH;
      sail.userData.hoistCentered = true;
      sail.userData.sailKind = 'square';
      sail.userData.trimPivot = trimPivot;
      sail.userData.phaseSeed = mastZ;
      // Cloth flutter: keep the rest-pose so per-frame displacement is additive
      sail.userData.clothBase = Float32Array.from(
        (sailGeo.attributes.position as THREE.BufferAttribute).array as Float32Array,
      );
      sail.userData.clothW = sailW;
      sail.userData.clothH = sailH;
      sail.castShadow = false;
      sail.receiveShadow = false;
      this.addSwiftSailTrim(sail, sailW, sailH, upgradeVisuals.swift_sails);
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
      const bundleSegs = 40;
      const bundleGeo = new THREE.CylinderGeometry(1, 1, bundleLen, 12, bundleSegs, true);
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
      const furled = new THREE.Mesh(bundleGeo, bundleMat);
      furled.rotation.z = Math.PI * 0.5;
      furled.castShadow = true;
      furledGroup.add(furled);
      // Rope gaskets lashing the bundle to the yard at intervals
      const gasketMat = new THREE.MeshStandardMaterial({ color: 0x6b5836, roughness: 1 });
      for (let g = -2; g <= 2; g++) {
        const gu = (g + 2) / (gasketCount - 1);
        const gasketY = -0.15 * (1 - Math.pow(2 * gu - 1, 2));
        const gasket = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.034, 5, 12), gasketMat);
        gasket.rotation.y = Math.PI * 0.5;
        gasket.position.set(g * bundleLen * 0.245, gasketY, 0);
        furledGroup.add(gasket);
        // Gasket tail hanging off the bundle — the giveaway that it is lashed.
        const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.013, 0.36, 5), gasketMat);
        tail.position.set(gasket.position.x + 0.04, gasketY - 0.36, 0.02);
        tail.rotation.z = 0.16 * (g % 2 === 0 ? 1 : -1);
        furledGroup.add(tail);
      }
      furledGroup.position.set(0, -mastH * 0.045, -0.04);
      furledGroup.userData.phaseSeed = mastZ;
      furledGroup.scale.y = 1;
      trimPivot.add(furledGroup);
      furledSails.push(furledGroup as unknown as THREE.Mesh);
    }

    // Crow's nest ladder — vertical rails hug the main mast pole (x=0), not offset toward the rail edge
    {
      const mainMastZ = getMainMastLocalZ(stats);
      const mastR = 0.075 + (ship.type === 'galleon' ? 0.045 : ship.type === 'brigantine' ? 0.025 : 0);
      const nestY = getCrowNestStandingY(stats);
      const ladderBottom = H + 0.2;
      const ladderTop = nestY + 0.02;
      const ladderH = Math.max(0.4, ladderTop - ladderBottom);
      const railMat = new THREE.MeshStandardMaterial({ map: this.darkWoodTex, roughness: 0.95 });
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
    }

    // Shared centerline sail ring, separated from side cannon click zones and anchor capstan.
    {
      const markerMat = new THREE.MeshStandardMaterial({ color: 0x3d2814, roughness: 1, side: THREE.DoubleSide });
      const brassMat = new THREE.MeshStandardMaterial({ color: 0xa8792a, roughness: 0.55, metalness: 0.55 });
      // Rail rope stations (SoT braces): worked from the bulwarks on BOTH
      // sides — coiled halyard rope on a belaying rack, tail dropping from
      // the rigging above. The floating deck-ring station is gone.
      const ropeStationMat = new THREE.MeshStandardMaterial({ color: 0xb99e6a, roughness: 0.95 });
      const mastHForHalyard = H * (stats.mastCount === 1 ? 3.6 : 3.1);
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
        ropeSegmentPts.push(
          new THREE.Vector3(rackX, H + 0.72, ropeStation.z),
          new THREE.Vector3(rackX * 0.1, H + mastHForHalyard * 0.55, getMainMastLocalZ(stats)),
        );
      }
      // Brace stations: cleat + coil at the quarterdeck rails, brace rope
      // running up to the yard END on that side — the physical "angle the
      // sails" handle ([X] hold sweeps the yard toward that rail).
      for (const brace of getBraceStationLocals(stats)) {
        const deckEdge = Math.abs(hullSurfacePointAt(profile, brace.z, H * 0.9).x);
        const bx = Math.sign(brace.x) * Math.min(Math.abs(brace.x), Math.max(0.9, deckEdge - 0.5));
        const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.14), markerMat);
        cleat.position.set(bx, H + 0.74, brace.z);
        cleat.castShadow = true;
        group.add(cleat);
        const braceCoil = makeRopeCoil(ropeStationMat, 0.18, 0.06, brace.z * 3 + 2, 2.3);
        braceCoil.rotation.z = Math.PI * 0.5;
        braceCoil.position.set(bx, H + 0.48, brace.z);
        group.add(braceCoil);
        ropeSegmentPts.push(
          new THREE.Vector3(bx, H + 0.7, brace.z),
          new THREE.Vector3(Math.sign(brace.x) * L * 0.2, H + mastHForHalyard * 0.6, getMainMastLocalZ(stats)),
        );
      }
    }

    // Forward jib — a triangular headsail whose LUFF runs along the forestay from
    // the bowsprit tip (forward + low) up to the foremast (aft + high), so the
    // canvas hugs the rig instead of floating as a vertical slab above the bow.
    // (Local X → world -Z after the y=90° rotation; local Y → world Y.)
    const jibShape = new THREE.Shape();
    jibShape.moveTo(-L * 0.20, 0);        // tack — at the bowsprit tip (world z≈L*0.76)
    jibShape.lineTo(L * 0.26, H * 0.30);  // clew — aft + low (sheet corner, the belly)
    jibShape.lineTo(L * 0.28, H * 1.18);  // head — up the foremast (world z≈L*0.28)
    jibShape.lineTo(-L * 0.20, 0);
    const jib = new THREE.Mesh(new THREE.ShapeGeometry(jibShape), sailMat.clone());
    jib.rotation.order = 'YXZ';
    // Jib is a stay-sail running on the centerline (YZ plane), so its plane normal
    // points sideways. It does NOT trim with the yardarm sails — fixed yaw.
    jib.rotation.y = Math.PI * 0.5;
    jib.position.set(0, H + 0.52, L * 0.56);
    jib.userData.hoistTopY = H + 0.52 + H * 1.18;
    jib.userData.hoistHeight = H * 1.18;
    jib.userData.hoistCentered = false;
    jib.userData.sailKind = 'stay';
    jib.userData.fixedYaw = Math.PI * 0.5;
    jib.userData.phaseSeed = L * 0.56;
    jib.castShadow = false;
    jib.receiveShadow = false;
    this.addSwiftSailTrim(jib, L * 0.24, H * 1.18, upgradeVisuals.swift_sails, true);
    group.add(jib);
    sails.push(jib);
    // Furled jib bundle lies ALONG the forestay (bowsprit tip → foremast head),
    // axis exactly on the stay so it reads as canvas lashed to it.
    const stayTip = new THREE.Vector3(0, H + 0.55, L * 0.76);
    const stayHead = new THREE.Vector3(0, H + H * 2.15, mastStartZ);
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

    // Fore-stay rigging (bowsprit to foremast)
    const foreMastZ = mastStartZ;
    ropeSegmentPts.push(
      new THREE.Vector3(0, H + H * 2.15, foreMastZ),
      new THREE.Vector3(0, H + 0.55, L * 0.76),
    );
    // Side stays land ON the bowsprit shaft just behind the tip — never in open air
    for (const sx of [-1, 1] as const) {
      ropeSegmentPts.push(
        new THREE.Vector3(sx * 0.06, H + 0.53, L * 0.72),
        new THREE.Vector3(0, H + H * 1.95, foreMastZ),
      );
    }

    // Flush all collected rigging into two draw calls
    if (ropeSegmentPts.length > 0) {
      group.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(ropeSegmentPts),
        new THREE.LineBasicMaterial({ color: 0x6a5030 }),
      ));
    }
    if (ratlineSegmentPts.length > 0) {
      group.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(ratlineSegmentPts),
        new THREE.LineBasicMaterial({ color: 0x4b3520 }),
      ));
    }

    // ── Cannons ──────────────────────────────────────────────
    const cannonGroups: CannonMeshGroup[] = [];
    const cannonCount = stats.cannonCount;
    const cannonsPerSide = cannonCount / 2;

    // Bigger, more visibly detailed cannons. Material highlights:
    // - Dark iron barrel with three brass reinforcing bands
    // - Brass muzzle bell at the front so the gun reads clearly even from far
    // - Beefier oak carriage with iron-banded wheels and trunnion caps
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb48335, roughness: 0.45, metalness: 0.7 });
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.55, metalness: 0.55 });
    const oakMat = new THREE.MeshStandardMaterial({ color: 0x4f3520, roughness: 0.95 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x261810, roughness: 0.95 });
    const ironBandMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.7 });
    const boreMat = new THREE.MeshBasicMaterial({ color: 0x040404 });
    const lashingMat = new THREE.MeshStandardMaterial({ color: 0xc8b27a, roughness: 1 });
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
          new THREE.CylinderGeometry(barrelR * 0.95, barrelR * 1.2, barrelLen, 14),
          ironMat,
        );
        barrel.rotation.z = Math.PI * 0.5;
        barrel.position.x = barrelLen * 0.5 - 0.1;
        barrel.castShadow = true;
        pitchPivot.add(barrel);

        // Brass reinforcing bands at three positions along the barrel
        for (const offset of [0.05, 0.55, 0.95] as const) {
          const band = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 1.2, barrelR * 1.25, 0.08, 14),
            brassMat,
          );
          band.rotation.z = Math.PI * 0.5;
          band.position.x = -0.1 + offset * barrelLen;
          pitchPivot.add(band);
        }

        // Brass muzzle bell — flared at the front so the gun reads clearly
        const muzzle = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 1.45, barrelR * 1.0, 0.18, 14),
          brassMat,
        );
        muzzle.rotation.z = Math.PI * 0.5;
        muzzle.position.x = barrelLen - 0.1 + 0.06;
        muzzle.castShadow = true;
        pitchPivot.add(muzzle);

        // Dark muzzle bore (interior)
        const bore = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.65, barrelR * 0.65, 0.06, 12),
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
            new THREE.CylinderGeometry(barrelR * 1.34, barrelR * 1.38, 0.035, 14),
            chargedMetalMat,
          );
          chargeBand.rotation.z = Math.PI * 0.5;
          chargeBand.position.x = -0.1 + offset * barrelLen;
          chargeGroup.add(chargeBand);
        }
        const muzzleGlow = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.72, 10, 8),
          chargedGlowMat,
        );
        muzzleGlow.position.x = barrelLen - 0.1 + 0.2;
        muzzleGlow.scale.set(1.35, 0.72, 0.72);
        chargeGroup.add(muzzleGlow);
        pitchPivot.add(chargeGroup);
        upgradeVisuals.charged_cannons.push(chargeGroup);

        // Cascabel (round knob at the back of the breech)
        const cascabel = new THREE.Mesh(
          new THREE.SphereGeometry(barrelR * 0.6, 10, 8),
          ironMat,
        );
        cascabel.position.x = -0.18;
        pitchPivot.add(cascabel);

        // Touch hole on top of the breech
        const touchHole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8),
          ironMat,
        );
        touchHole.position.set(0.06, barrelR * 1.0, 0);
        pitchPivot.add(touchHole);

        // Trunnion caps (the bumps that let the barrel pivot)
        for (const sz of [-1, 1] as const) {
          const trunnion = new THREE.Mesh(
            new THREE.CylinderGeometry(barrelR * 0.45, barrelR * 0.45, 0.16, 10),
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
              new THREE.CylinderGeometry(0.18, 0.18, 0.08, 12),
              wheelMat,
            );
            wheel.rotation.x = Math.PI * 0.5;
            wheel.position.set(wx, -0.18, wz);
            wheel.castShadow = true;
            cg.add(wheel);
            // Iron rim
            const rim = new THREE.Mesh(
              new THREE.TorusGeometry(0.18, 0.022, 6, 16),
              ironBandMat,
            );
            rim.rotation.x = Math.PI * 0.5;
            rim.position.set(wx, -0.18, wz);
            cg.add(rim);
          }
        }

        // Lashing rope on the back of the carriage (visual flair)
        const lashing = new THREE.Mesh(
          new THREE.TorusGeometry(0.1, 0.025, 6, 12),
          lashingMat,
        );
        lashing.rotation.y = Math.PI * 0.5;
        lashing.position.set(-0.16, 0.05, 0);
        cg.add(lashing);

        const sideSign = side === 0 ? 1 : -1;
        // Gunports anchored to the REAL loft surface so they neither bury into
        // the tumblehome nor float off the bow taper.
        const portSurf = hullSurfacePointAt(profile, cz, H * 0.58);
        const gunportFrame = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, 0.7, 0.85),
          oakMat,
        );
        gunportFrame.position.set(sideSign * (portSurf.x + 0.045), H * 0.58, cz);
        gunportFrame.rotation.z = sideSign * Math.atan2(portSurf.ny, portSurf.nx) * 0.6;
        gunportFrame.castShadow = true;
        group.add(gunportFrame);
        const gunportOpening = new THREE.Mesh(
          new THREE.BoxGeometry(0.095, 0.46, 0.62),
          this.holeMat,
        );
        gunportOpening.position.set(sideSign * (portSurf.x + 0.058), H * 0.59, cz);
        gunportOpening.rotation.z = gunportFrame.rotation.z;
        gunportOpening.castShadow = false;
        group.add(gunportOpening);
        // Hinged gunport door, flapped open
        const doorSurf = hullSurfacePointAt(profile, cz, H * 0.86);
        const gunportDoor = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.62), oakMat);
        gunportDoor.position.set(sideSign * (doorSurf.x + 0.06), H * 0.86, cz);
        gunportDoor.rotation.z = sideSign * 0.5;
        gunportDoor.castShadow = true;
        group.add(gunportDoor);

        // Merge rigid geometry per pivot: barrel hardware bakes into ~2 meshes
        // that still swing with the pitch pivot, carriage into a few under root.
        mergeStaticMeshes(chargeGroup, NO_MERGE_EXCLUDE);
        mergeStaticMeshes(pitchPivot, new Set<THREE.Object3D>([chargeGroup]));
        mergeStaticMeshes(cg, new Set<THREE.Object3D>([yawPivot]));

        cg.position.set(sideX, H + 0.18, cz);
        cg.rotation.y = side === 0 ? 0 : Math.PI;
        group.add(cg);
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

    const barrelHoopMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });
    const supplyBarrels: THREE.Group[] = [];
    const addSupplyBarrel = (kind: SupplyKind, x: number, z: number) => {
      const lidMat = new THREE.MeshStandardMaterial({ map: supplyLidTexture(kind), roughness: 0.78 });
      const barrel = makeBarrel(barrelWoodMat, barrelHoopMat, lidMat);
      barrel.name = `supply-barrel-${kind}`;
      barrel.userData.supplyKind = kind;
      barrel.position.set(x, H + 0.5, z);
      barrel.rotation.y = Math.random() * Math.PI * 2;
      // Bake the barrel's own staves/hoops, but keep the named group intact
      // (it's excluded from the ship-level merge below).
      mergeStaticMeshes(barrel, NO_MERGE_EXCLUDE);
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
      const crateOak = new THREE.MeshStandardMaterial({ color: 0x453019, roughness: 0.9 });
      const crateIron = new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 0.5, metalness: 0.65 });
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
      const ballMat = new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.35, metalness: 0.6 });
      for (const [bx, bz] of [[-0.2, 0.08], [0.05, -0.1], [0.26, 0.1], [0.02, 0.14]] as const) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), ballMat);
        ball.position.set(bx, 0.52, bz);
        crate.add(ball);
      }
      const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 0.3, 8), crateIron);
      horn.position.set(-0.32, 0.56, -0.18);
      horn.rotation.z = Math.PI * 0.4;
      crate.add(horn);
      mergeStaticMeshes(crate, NO_MERGE_EXCLUDE);
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
    for (const spot of decorSpots) {
      const lidMat = new THREE.MeshStandardMaterial({ color: spot.lid, roughness: 0.8 });
      const barrel = makeBarrel(barrelWoodMat, barrelHoopMat, lidMat);
      barrel.position.set(spot.x, H + 0.5, spot.z);
      barrel.rotation.y = Math.random() * Math.PI * 2;
      group.add(barrel);
    }

    // Mooring line flaked down near the stern quarter
    const sternRope = makeRopeCoil(ropeCoilMat, 0.24, 0.052, 7, 2.9);
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
    for (const mount of lanternMounts) {
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
    const mainMastH = H * (stats.mastCount === 1 ? 3.6 : 3.1);
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
    } satisfies Record<ShipUpgradeType, THREE.Mesh>;
    // Upgrade pennants keep their long-standing spot on the mast, well below the
    // nest (the team flag moved to the truck; these did not).
    const upgradePennantY = H + stats.height * 3;
    const upgradePennantEntries = [
      { type: 'hull_reinforcement' as const, x: 0.34, y: upgradePennantY - 0.72, z: mastStartZ + 0.12 },
      { type: 'charged_cannons' as const, x: 0.34, y: upgradePennantY - 0.98, z: mastStartZ + 0.02 },
      { type: 'swift_sails' as const, x: 0.34, y: upgradePennantY - 1.24, z: mastStartZ - 0.08 },
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
    mergeStaticMeshes(wheelGroup, NO_MERGE_EXCLUDE);
    mergeStaticMeshes(anchor, NO_MERGE_EXCLUDE);
    mergeStaticMeshes(anchorCapstan, new Set<THREE.Object3D>(
      capstanGrip ? [anchorChain, capstanGrip] : [anchorChain],
    ));
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
      holdWater,
    ]);
    mergeStaticMeshes(group, mergeExclude);

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

    const proxyRoot = this.buildShipProxy(ship, stats, proxySails);
    proxyRoot.visible = false;
    group.add(proxyRoot);

    group.position.set(ship.position.x, ship.position.y, ship.position.z);
    group.rotation.y = ship.rotation;
    this.scene.add(group);

    this.shipMeshes.set(ship.id, {
      root: group,
      detailRoot,
      proxyRoot,
      proxySails,
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
      cannonMeshes: cannonGroups,
      lanterns,
      wheel: wheelGroup,
      rudderPivot,
      compassNeedle,
      anchor,
      anchorChain,
      anchorCapstan,
      lanternGlassMats,
      nightLight,
      holdWater,
      holdWaterBase,
      holdCargoTiers: holdCargo.tiers,
      wake,
      hullHoleUniform,
      waterlineFoam,
      ownPennant,
    });

    return group;
  }

  /** Lazily built, shared across every breach on every hull. */
  private getHoleDecalGeo() {
    if (this.holeDecalGeo) return this.holeDecalGeo;
    const r = FLOODING.HOLE_VISUAL_RADIUS;
    // Splintered plank shards jutting from the rim — merged into one mesh so a
    // blown-through hole reads as jagged torn timber, not a drilled circle.
    const shardGeos: THREE.BufferGeometry[] = [];
    const shardCount = 7;
    for (let k = 0; k < shardCount; k++) {
      const a = (k / shardCount) * Math.PI * 2 + 0.3;
      const len = (0.14 + (k % 3) * 0.06) * (r / 0.4);
      const cone = new THREE.ConeGeometry(0.05 * (r / 0.4), len, 4);
      const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a - Math.PI * 0.5));
      const pos = new THREE.Vector3(
        Math.cos(a) * (r * 1.1 + len * 0.5),
        Math.sin(a) * (r * 1.1 + len * 0.5),
        (k % 2 ? 0.03 : -0.02),
      );
      cone.applyMatrix4(new THREE.Matrix4().compose(pos, rq, new THREE.Vector3(1, 1, 0.5)));
      shardGeos.push(cone);
    }
    const shards = mergeGeometries(shardGeos, false);
    for (const sg of shardGeos) sg.dispose();
    this.holeDecalGeo = {
      opening: new THREE.CircleGeometry(r, 16),
      rim: new THREE.RingGeometry(r * 1.05, r * 1.3, 16),
      shards,
      marker: new THREE.RingGeometry(r * 1.45, r * 1.8, 24),
    };
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

    // NO dark opening disc on the outer face: the hull shader DISCARDS the
    // planking inside this radius, so the breach is a genuine see-through hole
    // and a filled disc would just paint over it. Only the torn rim + splinters.
    const decal = new THREE.Group();
    decal.add(new THREE.Mesh(geo.rim, this.holeRimMat));
    if (geo.shards) decal.add(new THREE.Mesh(geo.shards, this.splinterMat));
    decal.quaternion.copy(quat);
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
    group.add(marker);
    mesh.root.add(group);

    // NO DECK-SIDE DECAL. It painted a fake "torn planking" disc on the INBOARD
    // bulwark at y = H + 0.17 whenever hole.y > 0.5H — but PhysicsSystem clamps
    // every hole to 0.6H at most, so that disc always sat about a metre above
    // the real breach on planking that was not holed, while the genuine
    // see-through opening is visible from the hold through the discard shader
    // (ships-15).
    return {
      group, decal, marker, gush, patch: null, point, normal,
      src: new THREE.Vector3(hole.x, hole.y, hole.z), patched: false,
    };
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
    vis.decal.quaternion.copy(quat);
    vis.gush.position.copy(normal).multiplyScalar(0.12);
    vis.gush.quaternion.copy(quat);
    vis.marker.position.copy(normal).multiplyScalar(0.06);
    vis.marker.quaternion.copy(quat);
    if (vis.patch) {
      // The plank was nailed over the OLD wound. A recycled slot is a fresh
      // hole by definition, so the carpentry goes with it.
      mesh.root.remove(vis.patch);
      vis.patch = null;
    }
  }

  private disposeHoleVis(mesh: ShipMeshGroup, vis: HoleVis) {
    mesh.root.remove(vis.group);
    if (vis.patch) mesh.root.remove(vis.patch);
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
    const patch = new THREE.Group();
    this.plankPatchMat ??= new THREE.MeshStandardMaterial({
      map: this.deckTex,
      color: 0xd7b98c,
      roughness: 0.88,
    });
    // A shallow scorched-looking backing board reads as a rim around the cross,
    // which is what separates it from the planking at distance.
    this.plankPatchRimMat ??= new THREE.MeshStandardMaterial({ color: 0x2a1a0d, roughness: 1 });
    const rim = new THREE.Mesh(new THREE.CircleGeometry(0.5, 14), this.plankPatchRimMat);
    rim.position.z = 0.008;
    patch.add(rim);
    for (let i = 0; i < 2; i++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.22, 0.05), this.plankPatchMat);
      plank.rotation.z = (i === 0 ? 0.5 : -0.45) + ((seed % 3) - 1) * 0.16;
      plank.position.z = 0.03 + i * 0.045;
      plank.castShadow = true;
      patch.add(plank);
    }
    patch.quaternion.setFromUnitVectors(HULL_Z_AXIS, vis.normal);
    patch.position.copy(vis.point).addScaledVector(vis.normal, 0.05);
    patch.userData.isPlankPatch = true;
    mesh.root.add(patch);
    vis.patch = patch;
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
        mesh.wake.group.visible = false;
        continue;
      }

      mesh.root.visible = true;
      const stats = SHIP_STATS[ship.type];
      const activeUpgrades = this.activeUpgrades;
      activeUpgrades.clear();
      for (let u = 0; u < ship.upgrades.length; u++) activeUpgrades.add(ship.upgrades[u].type);
      this.updateUpgradeVisuals(mesh, activeUpgrades);
      const detailDistance = this.quality === 'low' ? 170 : this.quality === 'balanced' ? 285 : 380;
      const distSq = cameraPosition
        ? (ship.position.x - cameraPosition.x) ** 2 + (ship.position.z - cameraPosition.z) ** 2
        : 0;
      const localCrewShip = !!localPlayerId && ship.crewIds.includes(localPlayerId);
      let detailNear = !cameraPosition || localCrewShip || distSq < detailDistance * detailDistance;
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
      mesh.proxyRoot.visible = !detailNear;
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
        const speed01 = THREE.MathUtils.clamp(Math.hypot(ship.velocity.x, ship.velocity.z) / 8, 0, 1);
        const breathe = 0.9 + 0.1 * Math.sin(t * 1.7 + ship.position.x * 0.05);
        mesh.waterlineFoam.visible = detailNear && !ship.sinking;
        foamMat.opacity = (0.52 + 0.34 * speed01 + 0.14 * storm01) * breathe;
        // ── WHICH ONE IS MINE ──────────────────────────────────────────────
        // The swallowtail says it at any range; the wet edge says it at boarding
        // range. Ten hulls in one anchorage differ only by team colour, and the
        // colour of a stranger's ship looks exactly as much like an identity as
        // the colour of your own, so an auditor fought half a match off someone
        // else's derelict without ever being told. The collar gilds over the
        // last 50 m — the distance at which you are choosing a gangway.
        mesh.ownPennant.visible = localCrewShip;
        if (localCrewShip) {
          const gild = cameraPosition
            ? THREE.MathUtils.clamp(1 - (Math.sqrt(distSq) - 22) / 28, 0, 1)
            : 1;
          foamMat.color.setRGB(1, 1 - 0.28 * gild, 1 - 0.62 * gild);
          foamMat.opacity = Math.min(1, foamMat.opacity * (1 + 0.55 * gild));
        } else if (foamMat.color.g !== 1 || foamMat.color.b !== 1) {
          foamMat.color.setRGB(1, 1, 1);
        }
        // Cancel the hull's pitch/roll (previous frame's settled value — one
        // frame of lag is invisible) so the wet edge stays glued to the sea
        // instead of riding the ship's attitude out of the water. The collar
        // ends up on a YAW-ONLY frame: the root is Ry·Rx·Rz, so the exact
        // inverse of its attitude (leaving the yaw alone) is Rz(-roll)·Rx(-pitch),
        // which is what Euler order 'ZXY' with y = 0 spells. The old
        // `rotation.set(-x, 0, -z)` was composed in the SAME wrong order as the
        // bug it was cancelling and left the ribbon tilted on every heading but
        // north/south (ships-01).
        mesh.waterlineFoam.rotation.set(-mesh.root.rotation.x, 0, -mesh.root.rotation.z, 'ZXY');
        if (foamMat.map) {
          foamMat.map.offset.x = (t * (0.03 + speed01 * 0.12)) % 1;
        }
        // Lift every collar vertex onto the LOCAL wave surface (world Gerstner
        // minus the hull's own heave). Without this the ribbon is a flat disc at
        // the hull's mean waterline and the very next crest buries it, which is
        // exactly how a correctly-drafted hull ends up reading as floating.
        if (mesh.waterlineFoam.visible) {
          const geo = mesh.waterlineFoam.geometry;
          const baseXZ = geo.userData.baseXZ as Float32Array | undefined;
          const rest = geo.userData.rest as Float32Array | undefined;
          const posAttr = geo.attributes.position as THREE.BufferAttribute;
          if (baseXZ && rest) {
            const cy = Math.cos(mesh.root.rotation.y);
            const sy = Math.sin(mesh.root.rotation.y);
            for (let i = 0; i < posAttr.count; i++) {
              const lx = baseXZ[i * 2];
              const lz = baseXZ[i * 2 + 1];
              const wx = mesh.root.position.x + lx * cy + lz * sy;
              const wz = mesh.root.position.z - lx * sy + lz * cy;
              posAttr.setY(i, gerstnerHeight(wx, wz, waveT, WAVE_PARAMS, storm01) - mesh.root.position.y + rest[i]);
            }
            posAttr.needsUpdate = true;
          }
        }
      }
      for (let s = 0; s < mesh.proxySails.length; s++) {
        const sail = mesh.proxySails[s];
        sail.visible = !detailNear && ship.sailHeight > 0.06;
        sail.rotation.y = THREE.MathUtils.lerp(sail.rotation.y, ship.sailAngle * 0.6, 1 - Math.exp(-8 * dt));
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, Math.max(0.18, ship.sailHeight), 1 - Math.exp(-8 * dt));
      }
      if (!detailNear) {
        // No client-only heel here either: the server's own attitude spring
        // already carries turn heel (±0.06) and wind heel, sampled from the real
        // Gerstner slopes at bow/stern/rails.
        const wavePitch = basePitch;
        const rollTarget = baseRoll;
        if (ship.sinking) {
          mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.5, 1 - Math.exp(-4 * dt));
          mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.36, 1 - Math.exp(-6 * dt));
          mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 4.5, 1 - Math.exp(-9 * dt));
        } else {
          mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3 * dt));
          mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3 * dt));
        }
        this.updateWake(mesh, ship, stats, waveT, dt, false, storm01);
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
      const helmAlpha = 1 - Math.exp(-9 * dt);
      mesh.wheel.rotation.z = THREE.MathUtils.lerp(
        mesh.wheel.rotation.z, -rudder01 * WHEEL_TURNS_LOCK_TO_LOCK * Math.PI, helmAlpha,
      );
      mesh.rudderPivot.rotation.y = THREE.MathUtils.lerp(mesh.rudderPivot.rotation.y, rudderAngle, helmAlpha);
      mesh.compassNeedle.rotation.y = -mesh.root.rotation.y;

      const anchorRaiseProgress = THREE.MathUtils.clamp(ship.anchorRaiseProgress ?? 0, 0, 1);
      const anchorDrop = ship.anchored ? 1 - anchorRaiseProgress : 0;
      if (ship.anchored && anchorRaiseProgress > 0) {
        mesh.anchorCapstan.rotation.y += dt * (3.6 + anchorRaiseProgress * 4.8);
      } else {
        mesh.anchorCapstan.rotation.y += dt * 0.08;
      }
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

      const wavePitch = basePitch;
      const rollTarget = baseRoll;

      // Sinking tilt
      if (ship.sinking) {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch * 0.6, 1 - Math.exp(-5 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, ship.sinkProgress * Math.PI * 0.42, 1 - Math.exp(-8 * dt));
        mesh.root.position.y = THREE.MathUtils.lerp(mesh.root.position.y, ship.position.y - ship.sinkProgress * 5, 1 - Math.exp(-11 * dt));
      } else {
        mesh.root.rotation.x = THREE.MathUtils.lerp(mesh.root.rotation.x, wavePitch, 1 - Math.exp(-3.8 * dt));
        mesh.root.rotation.z = THREE.MathUtils.lerp(mesh.root.rotation.z, rollTarget, 1 - Math.exp(-3.4 * dt));
      }

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
      for (let s = 0; s < mesh.sails.length; s++) {
        const sail = mesh.sails[s];
        sail.visible = ship.sailHeight > SAIL_FURL_THRESHOLD;
        const signedRelative = angleWrap(wind.direction - ship.rotation);
        // 0.92 matches the server's desired-trim constant (PhysicsSystem) so the
        // luff/billow visuals agree with the authoritative sail power.
        const desiredTrim = Math.sin(signedRelative) * SHIP.MAX_SAIL_ANGLE * 0.92;
        const rawTrimCatch = 1 - Math.min(1, Math.abs(angleWrap(ship.sailAngle - desiredTrim)) / SHIP.MAX_SAIL_ANGLE);
        const trimCatch = luffing ? Math.min(rawTrimCatch, 0.08) : rawTrimCatch;
        const phaseSeed = typeof sail.userData.phaseSeed === 'number' ? sail.userData.phaseSeed : sail.position.z;
        // Jibs and other stay-sails have a fixed yaw (centerline of the ship).
        // Square sails brace their whole trim pivot (yard + canvas + furled roll).
        const fixedYaw = sail.userData.fixedYaw;
        const trimPivot = sail.userData.trimPivot as THREE.Group | undefined;
        const targetSailYaw = typeof fixedYaw === 'number' ? fixedYaw : ship.sailAngle;
        const targetSailPitch = tornPitch * (0.55 + 0.15 * Math.sin(t * 0.9 + phaseSeed * 0.2));
        const deployedHeight = Math.max(0.06, ship.sailHeight * Math.max(0.22, sailIntegrity));
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
        sail.position.y = THREE.MathUtils.lerp(sail.position.y, targetSailY, sailAlpha);
        sail.scale.y = THREE.MathUtils.lerp(sail.scale.y, deployedHeight, sailAlpha);
        // Billow puffs the sail outward along its normal — that's the +Z axis in its
        // own local frame (set up at construction). scale.z grows the billow depth.
        const billow = Math.sin(t * 1.2 + phaseSeed * 0.3) * (0.12 + trimCatch * 0.2) * ship.sailHeight * sailIntegrity;
        sail.scale.z = THREE.MathUtils.lerp(sail.scale.z, 1 + billow, sailAlpha);
        if (sail.visible) {
          if (sail.userData.sailKind === 'stay') {
            // Jib has no cloth grid — a leech shiver keeps it alive, stronger when
            // depowered and hardest when luffing.
            const shiver = luffing ? 0.055 : 0.012 + (1 - trimCatch) * 0.028;
            const freq = luffing ? 13.5 : 7.4;
            sail.rotation.z = Math.sin(t * freq + phaseSeed * 0.5) * shiver * ship.sailHeight;
          } else {
            this.updateSailCloth(sail, t, wind.strength, trimCatch, ship.sailHeight, sailIntegrity, luffing);
          }
        }
      }
      for (let f = 0; f < mesh.furledSails.length; f++) {
        const furled = mesh.furledSails[f];
        furled.visible = ship.sailHeight <= SAIL_FURL_THRESHOLD;
        const furledSeed = typeof furled.userData.phaseSeed === 'number' ? furled.userData.phaseSeed : furled.position.z;
        furled.scale.setScalar(0.88 + Math.sin(t * 0.9 + furledSeed) * 0.015);
      }

      const localWind = angleWrap(wind.direction - ship.rotation);

      // Masthead flag: stream downwind off the pivot's +X, and ripple harder the
      // faster you sail and the worse the weather. Phase is per-ship (id hash),
      // so a fleet never flutters in unison.
      mesh.flag.pivot.rotation.y = Math.PI * 0.5 + localWind;
      const flagSpeed01 = Math.min(1, Math.hypot(ship.velocity.x, ship.velocity.z) / 9);
      mesh.flag.uniforms.uFlagTime.value = t;
      // Even becalmed at anchor the cloth breathes (0.012 m) — a dead-still flag
      // is what made it read as a painted board.
      mesh.flag.uniforms.uFlagWave.value.x =
        0.012 + wind.strength * 0.032 + flagSpeed01 * 0.030 + storm01 * 0.055;

      for (let p = 0; p < mesh.pennants.length; p++) {
        const pennant = mesh.pennants[p];
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 8 + pennant.position.z * 0.14) * 0.12;
        pennant.scale.x = 1.05 + wind.strength * 0.65 + Math.min(0.4, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.03);
      }
      const pennantTypes = this.upgradePennantTypes
        ??= Object.keys(mesh.upgradePennants) as ShipUpgradeType[];
      for (const type of pennantTypes) {
        const pennant = mesh.upgradePennants[type];
        pennant.visible = activeUpgrades.has(type);
        if (!pennant.visible) continue;
        pennant.rotation.y = Math.PI * 0.5 + localWind;
        pennant.rotation.z = Math.sin(t * 9.5 + pennant.position.y * 0.3) * 0.18;
        pennant.scale.x = 1.1 + wind.strength * 0.55 + Math.min(0.35, Math.hypot(ship.velocity.x, ship.velocity.z) * 0.025);
      }

      const cannonsPerSide = Math.max(1, SHIP_STATS[ship.type].cannonCount / 2);
      const shipOperators = cannonOperators.get(ship.id);
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
        cannon.yawPivot.rotation.y += angleWrap(desiredYaw - cannon.yawPivot.rotation.y) * cannonAlpha;
        cannon.pitchPivot.rotation.z = THREE.MathUtils.lerp(cannon.pitchPivot.rotation.z, desiredPitch, cannonAlpha);
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

      // Animated foam wake ribbon + bow spray, tracking the Gerstner surface
      this.updateWake(mesh, ship, stats, waveT, dt, true, storm01);

      // Shared pulse for every hole halo (one material, breathing in sync).
      this.holeMarkerMat.opacity = 0.28 + 0.24 * (0.5 + 0.5 * Math.sin(t * 3.4));
      // Breaches are ENTITIES: diff the wire list against the decals we already
      // built, keyed by ShipHole.id. A new id spawns a decal exactly where the
      // shot landed; a patched flip swaps it for crossed planks at the SAME
      // point; a vanished id disposes. No count heuristics, so a re-punched
      // spot can never end up with a plank floating over an open hole.
      {
        const holes = ship.holes ?? [];
        let holeSlot = 0;
        for (const hole of holes) {
          let vis = mesh.holeVis.get(hole.id);
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
              mesh.root.remove(vis.patch);
              vis.patch = null;
            }
          }
          const open = !vis.patched;
          vis.group.visible = open;
          vis.marker.visible = open && !ship.sinking;
          if (open && holeSlot < mesh.hullHoleUniform.value.length) {
            // One shader slot per OPEN breach, all at the same radius: damage
            // depth reads as more holes, never as one growing disc.
            mesh.hullHoleUniform.value[holeSlot].set(
              vis.point.x, vis.point.y, vis.point.z, FLOODING.HOLE_VISUAL_RADIUS,
            );
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
          if (vis.marker.visible) vis.marker.scale.setScalar(markerPulse);
        }
        for (; holeSlot < mesh.hullHoleUniform.value.length; holeSlot++) {
          mesh.hullHoleUniform.value[holeSlot].set(0, 0, 0, 0);
        }
      }

      // Hold cargo: the crew's banked gold, standing up in the hold as crates and
      // coin. One tier variant visible at a time (cumulative geometry), so the
      // stack GROWS as they bank and empties the moment a boarder cuts it out of
      // them. This is the only place in the game where "who is winning" is a
      // question you answer by looking at a ship instead of reading a number.
      if (mesh.holdCargoTiers.length > 0) {
        const tier = ship.sinking ? 0 : cargoTier(ship.cargoGold ?? 0);
        for (let i = 0; i < mesh.holdCargoTiers.length; i += 1) {
          mesh.holdCargoTiers[i].visible = i === tier - 1;
        }
      }

      // Water-in-hull: a dark plane rises with the flood level, visible from above
      // through the open companionway / hatch grating. `waterLevel` is a naval-track
      // field (read defensively). Past 0.55 the surface sloshes harder as a spill
      // hint; streaming-water particle FX at the holes is left for the CombatFx pass.
      if (mesh.holdWater && mesh.holdWaterBase) {
        const waterLevel = THREE.MathUtils.clamp(
          (ship as unknown as { waterLevel?: number }).waterLevel ?? 0, 0, 1,
        );
        // The rising water IS the drama: keep it visible through the founder
        // (it used to vanish the instant sinking started), let it climb past
        // the hold and wash OVER the deck planks in the final stage, and
        // slosh harder the fuller the hull gets.
        const sinkLevel = ship.sinking ? 1 : waterLevel;
        const show = sinkLevel > 0.02;
        mesh.holdWater.visible = show;
        if (show) {
          const floorY = 0.5;
          const holdTopY = stats.height - 0.12;
          // 0 → 0.8: fill the hold. 0.8 → 1: break over the deck (deck slab
          // top sits at H + 0.025; +0.09 reads as a sheet of water on deck).
          const awash = THREE.MathUtils.clamp((sinkLevel - 0.8) / 0.2, 0, 1);
          const topY = awash > 0
            ? holdTopY + (stats.height + 0.09 - holdTopY) * awash
            : holdTopY;
          const fillT = Math.min(1, sinkLevel / 0.8);
          mesh.holdWater.position.y = awash > 0 ? topY : floorY + (holdTopY - floorY) * fillT;
          const agitation = 1 + sinkLevel * 1.6 + (ship.sinking ? 0.8 : 0);
          const base = mesh.holdWaterBase;
          const posAttr = mesh.holdWater.geometry.attributes.position as THREE.BufferAttribute;
          const arr = posAttr.array as Float32Array;
          const amp = 0.03 * agitation;
          for (let i = 0; i < posAttr.count; i++) {
            const i3 = i * 3;
            arr[i3 + 1] = base[i3 + 1] + Math.sin(t * (1.8 + agitation) + base[i3] * 1.3 + base[i3 + 2] * 0.9) * amp;
          }
          posAttr.needsUpdate = true;
          const mat = mesh.holdWater.material as THREE.MeshStandardMaterial;
          mat.opacity = 0.82 + 0.12 * Math.min(1, sinkLevel * 1.4);
          // Awash water flashes brighter foam-green so the overwhelm reads at a glance.
          mat.emissiveIntensity = 0.4 + awash * 0.5;
        }
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

    // Tapered foam ribbon: WAKE_ROWS rows x 3 columns, positions rewritten
    // every frame in world space along the ship's track.
    const vertCount = WAKE_ROWS * WAKE_COLS;
    const positions = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    const uvs = new Float32Array(vertCount * 2);
    const colors = new Float32Array(vertCount * 4);
    for (let row = 0; row < WAKE_ROWS; row++) {
      const jt = row / (WAKE_ROWS - 1);
      const rowAlpha = Math.pow(1 - jt, 1.35);
      for (let col = 0; col < WAKE_COLS; col++) {
        const i = row * WAKE_COLS + col;
        uvs[i * 2] = col / (WAKE_COLS - 1);
        uvs[i * 2 + 1] = jt * 2; // texture tiles twice along the ribbon
        const edge = col === 1 ? 1 : 0.32;
        colors[i * 4] = 1;
        colors[i * 4 + 1] = 1;
        colors[i * 4 + 2] = 1;
        colors[i * 4 + 3] = rowAlpha * edge;
      }
    }
    const indices: number[] = [];
    for (let row = 0; row < WAKE_ROWS - 1; row++) {
      for (let col = 0; col < WAKE_COLS - 1; col++) {
        const a = row * WAKE_COLS + col;
        const b = a + 1;
        const c = a + WAKE_COLS;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', positions);
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geo.setIndex(indices);

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

    const ribbon = new THREE.Mesh(geo, material);
    ribbon.renderOrder = 2;
    ribbon.frustumCulled = false;
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
    return { group, ribbon, positions, material, spray, sprayCursor: 0, sprayTimer: 0, scroll: 0 };
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

    const pos = wake.positions;
    for (let row = 0; row < WAKE_ROWS; row++) {
      const jt = row / (WAKE_ROWS - 1);
      const dist = Math.pow(jt, 1.25) * wakeLen;
      const sway = Math.sin(waveT * 0.9 + jt * 4.2) * W * 0.05 * jt;
      const cx = sternX - fwdX * dist + latX * sway;
      const cz = sternZ - fwdZ * dist + latZ * sway;
      const half = W * (0.14 + jt * (0.42 + 0.42 * speedFrac));
      for (let col = 0; col < WAKE_COLS; col++) {
        const u = col - 1; // -1, 0, 1
        const x = cx + latX * half * u;
        const z = cz + latZ * half * u;
        const y = gerstnerHeight(x, z, waveT, WAVE_PARAMS, storm) + 0.08 + (1 - jt) * 0.04;
        pos.setXYZ(row * WAKE_COLS + col, x, y, z);
      }
    }
    pos.needsUpdate = true;

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

  /** CPU cloth: traveling wind ripple plus hard luff flutter when the sail is
   *  depowered (trim far from the wind). Displaces the low-vert sail plane
   *  along its billow normal; the yard-attached top edge stays pinned. */
  private updateSailCloth(
    sail: THREE.Mesh,
    t: number,
    windStrength: number,
    trimCatch: number,
    sailHeight: number,
    sailIntegrity: number,
    luffing = false,
  ) {
    const base = sail.userData.clothBase as Float32Array | undefined;
    if (!base) return;
    const w = sail.userData.clothW as number;
    const h = sail.userData.clothH as number;
    const minDim = Math.min(w, h);
    const phaseSeed = typeof sail.userData.phaseSeed === 'number' ? sail.userData.phaseSeed : sail.position.z;
    const phase = phaseSeed * 0.7 + sail.position.y * 0.31;
    const rippleAmp = (0.012 + 0.02 * windStrength) * minDim * sailHeight;
    const depower = 1 - trimCatch;
    // Luffing hits the whole sail (not just the leech) with a fast, deep flap.
    const luffGain = luffing ? 0.14 : 0.055;
    const luffFreq = luffing ? 16.5 : 11.5;
    const luffAmp = Math.min(0.55, depower * depower * luffGain * minDim) * sailHeight * (0.4 + 0.6 * sailIntegrity);
    if (rippleAmp < 0.001 && luffAmp < 0.001) return;

    const posAttr = sail.geometry.attributes.position as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const invH = 1 / Math.max(h, 0.001);
    for (let i = 0; i < posAttr.count; i++) {
      const i3 = i * 3;
      const x = base[i3];
      const y = base[i3 + 1];
      const nyTop = (y + h * 0.5) * invH; // 1 at the yard, 0 at the foot
      const pin = 1 - nyTop * nyTop;
      const ripple = Math.sin(t * 2.7 + x * 0.85 + y * 0.55 + phase) * rippleAmp;
      const luff = Math.sin(t * luffFreq + x * 2.7 + phase * 1.7) * luffAmp;
      arr[i3 + 2] = base[i3 + 2] + (ripple + luff) * pin;
    }
    posAttr.needsUpdate = true;
    // Normal recompute is the expensive half of the cloth sim and the low-amp
    // ripple barely moves them — refresh every 3rd frame, staggered per sail.
    if ((this.frameIndex + sail.id) % 3 === 0) {
      sail.geometry.computeVertexNormals();
    }
  }

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
