/**
 * Ambient world FX owned outside the island meshes: the island lantern/campfire
 * light budget, volcanic per-frame closures, drifting wind wisps, the storm rain
 * + lightning overlay, and the harvest promote/topple destruction actors.
 */
import * as THREE from 'three';
import { HARVEST, PLAYER, SHIP_STATS, STORM_PHASES } from '../../shared/constants/index.js';
import type { GameState, Island, IslandProp, IslandPropType, Player, Ship } from '../../shared/types/index.js';
import {
  dist2D,
  getIslandMaxRadius,
  getIslandSurfaceY,
  getShipDeckRaiseAt,
  getShipDeckY,
  isInsideCaveInterior,
  isPointInsideIslandFootprint,
  sampleWind,
} from '../../shared/utils/index.js';
import { getPropGroundY } from '../../shared/props.js';
import { propBaseLift } from '../world/island/PropScatterer.js';
import type { AssetName } from '../assets/AssetLibrary.js';
import type { SoundEngine } from '../audio/SoundEngine.js';
import type { LanternEmitter, StoryCutsceneRefs, WindWispRecord } from '../core/Game.js';
import type { InputManager } from '../input/InputManager.js';
import type { CombatFx } from './CombatFx.js';
import type { OceanRenderer } from './OceanRenderer.js';
import type { Renderer } from './Renderer.js';
import { registerBudgetLight } from './LightBudget.js';
import { makeLanternFlameTexture, makeLanternGlowTexture, makeWindWispTexture } from './factories/TextureFactory.js';
import { refreshFrozenChild, ZERO_SCALE_MAT4 } from './three-util.js';

export type EnvironmentFxView = {
  readonly audio: SoundEngine;
  readonly combatFx: CombatFx;
  readonly input: InputManager;
  readonly ocean: OceanRenderer;
  readonly renderer: Renderer;
  readonly islandMeshes: Map<string, THREE.Group>;
  readonly islandPropInstances: Map<string, Map<number, { inst: THREE.InstancedMesh; index: number }>>;
  readonly magmaPulseUniform: { value: number };
  readonly playersById: Map<string, Player>;
  readonly state: GameState | null;
  readonly stormWeatherIntensity: number;
  /** What the weather LOOKS like: the storm's own level raised by whatever rain
   *  the client is drawing. Sea colour, fog, scene lights and sky all read it. */
  readonly stormVisualIntensity: number;
  storyCutscene: StoryCutsceneRefs | null;
  buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale?: number): THREE.Group | null;
  disposeSceneObject(root: THREE.Object3D): void;
  getLocalPlayer(): Player | null;
  getTrackedShip(): Ship | null;
};

/** One camera-relative rain shell. Near shells are sparse with long fast
 *  streaks, far shells dense with short slow ones; overlapping them is what
 *  gives the downpour depth instead of reading as one flat sheet. */
type RainShell = {
  lines: THREE.LineSegments;
  material: THREE.LineBasicMaterial;
  geo: THREE.BufferGeometry;
  /** Head + tail vertex per drop (6 floats). */
  pos: Float32Array;
  /** Head + tail RGBA per drop (8 floats); the alphas carry the range fade. */
  colorArr: Float32Array;
  /** Per-drop [0,1) hash: gust-band density gate and per-drop length jitter. */
  hash: Float32Array;
  drops: number;
  /** Spawn-disc radius and spawn height above the camera. */
  radius: number;
  ceiling: number;
  /** Streak length and fall-speed multipliers. */
  streak: number;
  speed: number;
  opacity: number;
  /** Offsets this shell's gust waves so the layers don't march in lockstep. */
  gustPhase: number;
};

/** Impact FX pool: flat expanding splash rings plus the bounce droplets that
 *  kick off them. Both are single InstancedMeshes — two draws for every
 *  impact in the world. Rings tagged `onShip` ride the ship frame. */
type SplashPool = {
  rings: THREE.InstancedMesh;
  droplets: THREE.InstancedMesh;
  ringCount: number;
  dropletCount: number;
  /** Rings: x, y, z, age (4 floats). Ship-borne rings store hull-local x/z. */
  ring: Float32Array;
  ringLife: Float32Array;
  ringSize: Float32Array;
  ringOnShip: Uint8Array;
  ringCursor: number;
  /** Droplets: x, y, z, vx, vy, vz, age (7 floats). */
  droplet: Float32Array;
  dropletLife: Float32Array;
  dropletSize: Float32Array;
  dropletCursor: number;
};

// Rain shell presets, near → far. Quality tiers pick a subset (see RAIN_TIERS).
const RAIN_SHELL_SPECS = [
  { radius: 13, ceiling: 16, drops: 760, streak: 2.40, speed: 1.30, opacity: 0.52, gustPhase: 0 },
  { radius: 32, ceiling: 24, drops: 1320, streak: 1.25, speed: 1.00, opacity: 0.40, gustPhase: 1.9 },
  { radius: 68, ceiling: 34, drops: 1500, streak: 0.66, speed: 0.86, opacity: 0.26, gustPhase: 3.7 },
] as const;

/** Per-shell hard cap on simultaneously integrated drops, per tier. */
const RAIN_ACTIVE_CEILING: Record<'low' | 'balanced' | 'high', number> = {
  low: 260,
  balanced: 900,
  high: 1600,
};

/** Which shells (and what fraction of their drop budget) each tier gets. */
const RAIN_TIERS: Record<'low' | 'balanced' | 'high', { shells: number[]; scale: number }> = {
  low: { shells: [1], scale: 0.5 },
  balanced: { shells: [0, 2], scale: 0.75 },
  high: { shells: [0, 1, 2], scale: 1 },
};

// Rain streaks fade out with range from the eye: full strength close in, gone
// by ~120m, so the downpour reads as depth-layered weather instead of a decal
// stuck to the screen over a distant horizon.
const RAIN_FADE_NEAR = 30;
const RAIN_FADE_FAR = 120;
const RAIN_FADE_INV_SPAN = 1 / (RAIN_FADE_FAR - RAIN_FADE_NEAR);

// Travelling gust bands are baked into an along-wind lookup table once per
// frame per shell, so the per-drop inner loop costs a table index and a few
// multiplies — no trig, no allocation, however hard it is raining.
const RAIN_BANDS = 64;
const RAIN_BAND_METRES = 6;
const RAIN_BAND_SPAN = RAIN_BANDS * RAIN_BAND_METRES;
const RAIN_INV_BAND = 1 / RAIN_BAND_METRES;
// Band wavelengths must divide the LUT span exactly or the wrap seam shows.
const RAIN_GUST_K1 = (Math.PI * 2 * 6) / RAIN_BAND_SPAN; // ~64m squall bands
const RAIN_GUST_K2 = (Math.PI * 2) / RAIN_BAND_SPAN;     // ~384m slow swell

// ── Storm front (the weather that LIVES at the ring boundary) ───────────────
// The safe-zone boundary used to be one translucent slate cylinder: a flat
// vertical veil with a straight rim, no cloud, no rain, no gradient. Read from
// a deck it was an edge in the sky rather than weather, and at night it was a
// hard-edged hole where the stars stopped — a fresh player assumed the renderer
// had broken. That cylinder is GONE; this shell replaced it outright (nothing
// else is drawn at the ring any more) and gives the boundary an identity:
// a ragged cloud BANK whose underside hangs at ~40% of the shell
// height, a rain CURTAIN scrolling out of that bank down to the water, and a
// desaturating sea-level MIST band, all dissolving into the scene fog with
// range so the far side of the ring is haze rather than a crisp second wall.
const FRONT_HEIGHT = 320;
/** How far the shell's base sits BELOW the waterline; the curtain has to start
 *  under the swell or storm troughs open a gap under the rain. */
const FRONT_BASE_DROP = 26;
/** World Y of the shell's top rim — the one height in here that is GEOMETRY and
 *  not a gradient, so it is the one height the bank's own fade has to finish
 *  under. See FRONT_TOP_ROOM below. */
const FRONT_TOP_Y = FRONT_HEIGHT - FRONT_BASE_DROP;
/** ── THE ARC ACROSS THE SKY ────────────────────────────────────────────────
 *  This shell was the "sky-dome rim seam": a hard curved edge in every frame at
 *  every hour, deep sky above it and pale haze below, read by two audits as the
 *  dome's lower rim meeting the horizon band. It is neither — it is THIS
 *  cylinder's top edge, and the arithmetic says so. `bank`'s upper fade ended at
 *  bTop + topY*0.55; at ring range (baseY ramped to 105) that is 391-513 m of
 *  world height against 294 m of geometry, so the bank was still ~0.9 opaque
 *  where the mesh ran out and the wall simply stopped mid-veil. Measured from
 *  the audit shots the edge sat on a horizontal circle at r≈700-830 m, y≈294 —
 *  the rim, to the metre, from deck height and from 200 m up alike.
 *
 *  So the bank profile is now BOUNDED BY THE GEOMETRY: topY is capped so that
 *  the ragged top (up to 1.22*topY) plus its own fade (0.55*topY) both land
 *  under the rim with room to spare, and a final taper drives alpha to zero
 *  before the last row of quads regardless. A gradient that ends before the
 *  surface does has no edge in it. */
const FRONT_TOP_ROOM = 1.22 + 0.55;

const STORM_FRONT_VERT = /* glsl */`
  varying vec3 v_world;
  varying float v_h;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    v_world = wp.xyz;
    v_h = uv.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const STORM_FRONT_FRAG = /* glsl */`
  uniform vec3  u_cam;
  uniform float u_time;
  uniform float u_intensity;
  uniform float u_night;
  uniform vec3  u_horizon;
  uniform vec3  u_fog;
  uniform float u_flash;
  uniform vec2  u_flashDir;
  varying vec3  v_world;
  varying float v_h;

  float fHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float fNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x),
      mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  float fFbm(vec2 p) {
    return fNoise(p) * 0.58 + fNoise(p * 2.07 + 17.3) * 0.28 + fNoise(p * 4.11 + 5.7) * 0.14;
  }

  void main() {
    // Noise is sampled in WORLD xz, so it wraps around the ring by construction
    // — a uv.x-based pattern would leave a seam down one bearing of the wall.
    vec2 fp = v_world.xz;
    float y = v_world.y;
    float d = max(1.0, length(u_cam.xz - fp));
    float lobe = fFbm(fp * 0.0060 + u_time * vec2(0.0040, 0.0026));   // ~170m cloud lobes
    // The bottom tier pays for ONE noise field: the front is a full-screen
    // transparent surface when you are up against it, and three fbm fetches per
    // pixel of it is the whole frame budget on a fanless laptop. The bank keeps
    // its ragged silhouette; only the finer bulges and the curtain's column
    // breakup are dropped.
#ifdef FRONT_CHEAP
    float lobe2 = 1.0 - lobe;
#else
    float lobe2 = fFbm(fp * 0.0185 - u_time * vec2(0.0090, 0.0055));  // ~55m bulges
#endif

    // The bank's height above the water is chosen from the RANGE of the piece of
    // wall being drawn. One fixed profile cannot work at both ends: a cloud deck
    // that sits right for a squall line 900m off is 40° overhead when you sail up
    // to it (so the whole bank leaves the frame and you see nothing but haze),
    // and one that reads from 60m is a sliver on the horizon. Ramping the deck
    // down as you close keeps a legible bank + curtain at every range.
    float baseY = mix(26.0, 105.0, smoothstep(70.0, 760.0, d));
    // Capped so the ragged top AND its fade finish under the shell's rim (see
    // FRONT_TOP_ROOM): past ~370 m the deck stops climbing instead of climbing
    // out through the top of the geometry. Close in, where the bank is supposed
    // to tower, this cap is nowhere near the profile and does nothing.
    float topY = min(baseY * 2.4 + 42.0, ${(FRONT_TOP_Y / (FRONT_TOP_ROOM * 1.12)).toFixed(1)});

    // Ragged underside AND ragged top: no straight cut anywhere on the silhouette.
    float bBase = baseY * (0.74 + lobe * 0.52);
    float bTop = topY * (0.80 + lobe2 * 0.42);
    float bank = smoothstep(bBase - baseY * 0.36, bBase + baseY * 0.30, y)
               * (1.0 - smoothstep(bTop - topY * 0.12, bTop + topY * 0.55, y));

    // Rain curtain: scrolling columns hanging out of the bank to the water.
#ifdef FRONT_CHEAP
    float colN = 0.30 + 0.40 * lobe;
#else
    float colN = fFbm(vec2(dot(fp, vec2(0.052, 0.047)), y * 0.055 - u_time * 0.55));
#endif
    float curtain = (1.0 - smoothstep(bBase * 0.55, bBase * 1.20, y))
                  * smoothstep(-3.0, 6.0, y)
                  * (0.26 + 0.74 * smoothstep(0.28, 0.72, colN));

    // Sea-level mist: the desaturation gradient you sail into before the wall.
    float mist = (1.0 - smoothstep(1.0, baseY * 0.55, y)) * (0.44 + 0.36 * lobe2);

    // Colours are DERIVED from the sky's own horizon tint, so the front is grey
    // slate at noon, bruised plum at dusk, and moonlit blue at night without a
    // second palette to keep in sync. The uniforms arrive in three's LINEAR
    // working space, so these scales are linear too — display-referred numbers
    // here rendered the bank as a pale white saucer parked over the sea.
    vec3 grey = vec3(dot(u_horizon, vec3(0.299, 0.587, 0.114)));
    vec3 cloudCol = mix(u_horizon, grey, 0.55) * mix(0.055, 0.20, u_night);
    vec3 rainCol  = mix(u_horizon, grey, 0.35) * mix(0.160, 0.85, u_night);
    vec3 mistCol  = mix(u_horizon, grey, 0.22) * mix(0.260, 0.75, u_night);

    float wBank = bank * 0.88;
    float wRain = curtain * 0.55;
    float wMist = mist * 0.26;
    float wSum = wBank + wRain + wMist;
    vec3 col = (cloudCol * wBank + rainCol * wRain + mistCol * wMist) / max(0.0001, wSum);

    // Lit fringe along the top of the bank — the edge of a cloud catches the sky,
    // which is exactly what a hard black rim does not do.
    float rim = smoothstep(bTop - topY * 0.18, bTop + topY * 0.03, y)
              * (1.0 - smoothstep(bTop + topY * 0.02, bTop + topY * 0.30, y));
    col += mix(u_horizon, grey, 0.2) * rim * mix(0.060, 0.035, u_night);

    float a = clamp(wSum, 0.0, 1.0);

    // Whatever alpha would still be alive at the last row of quads is a hard
    // geometric arc in the sky, so nothing is allowed to reach it. The cap on
    // topY already lands the bank's fade ~30 m under the rim; this is the rail
    // that holds even if the noise fields are retuned. v_h is the shell's own
    // parametric height, so it stays true if FRONT_HEIGHT ever moves.
    a *= 1.0 - smoothstep(0.88, 0.995, v_h);

    // Lightning lights the bank from inside, brightest toward the bolt's bearing.
    if (u_flash > 0.001) {
      vec2 toFrag = fp - u_cam.xz;
      float align = max(0.0, dot(toFrag / max(1.0, length(toFrag)), u_flashDir));
      float lobeF = 0.10 + 0.90 * align * align;
      col += vec3(0.55, 0.66, 0.95) * u_flash * lobeF * (0.22 + 0.78 * bank);
      a = clamp(a + u_flash * lobeF * bank * 0.22, 0.0, 1.0);
    }

    // Range dissolve: the far side of a 900m ring must read as haze, never as a
    // second crisp wall standing behind the near one.
    float fogAmt = 1.0 - exp(-d * 0.0013);
    col = mix(col, u_fog, fogAmt * 0.85);
    a *= 1.0 - fogAmt * 0.35;
    // Deep inside the safe zone the ring is DISTANT weather, not something that
    // may lay a veil across half a fair sky: past ~400m the front thins to a
    // horizon-band haze, and the far side of the ring never reads as a second
    // wall standing behind the near one.
    a *= 1.0 - smoothstep(380.0, 1500.0, d) * 0.78;
    a *= u_intensity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`;

// Lightning channel budget: one main stroke plus 2–4 forks, all in a single
// pooled ribbon (2 draws — core + glow) that lives for one strike.
const BOLT_MAIN_NODES = 17;
const BOLT_MAX_NODES = 56;
const BOLT_MAX_SEGMENTS = 52;
const BOLT_LIFE = 0.45;

export class EnvironmentFx {
  constructor(private readonly view: EnvironmentFxView) {}

  // Island lantern / campfire warm-light budget.
  readonly lanternRoot = new THREE.Group();
  readonly lanternLightPool: THREE.PointLight[] = [];
  readonly campfireLightPool: THREE.PointLight[] = [];
  readonly lanternEmitters: LanternEmitter[] = [];
  readonly assignedLanterns: LanternEmitter[] = [];
  readonly assignedCampfires: LanternEmitter[] = [];
  lanternGlowTexture: THREE.Texture | null = null;
  lanternFlameTexture: THREE.Texture | null = null;
  /** Per-frame FX closures for volcanic islands (ash drift, embers, smoke,
   *  caldera lava, erupting geyser plumes). Cleared with the island meshes. */
  volcanicFx: Array<(dt: number, worldTime: number, camera: THREE.Vector3) => void> = [];
  /** Waterfall emitters per island (world space), replaced on every rebuild. */
  private readonly waterfallSites = new Map<string, { x: number; y: number; z: number; scale: number }[]>();
  lightningFlash: THREE.PointLight | null = null;
  lightningTimer = 4 + Math.random() * 6;
  stormRainCanvas: HTMLCanvasElement | null = null;
  stormRainCtx: CanvasRenderingContext2D | null = null;
  stormLightningFlashEl: HTMLDivElement | null = null;
  stormLightningFlashOpacity = 0;
  lightningLightPool: THREE.PointLight | null = null;
  readonly windWispTexture = makeWindWispTexture();
  /** Locally-promoted harvest target: the instanced palm/boulder is swapped for a
   *  live clone while the axe works it, so strikes shake it and completion plays a
   *  real breakdown. One slot — the axe only ever works one prop at a time. */
  harvestPromoted: {
    islandId: string;
    propId: number;
    type: IslandPropType;
    node: THREE.Object3D;
    /** Original instance matrix, restored on a clean demote (chop abandoned). */
    savedMatrix: THREE.Matrix4;
    basePos: THREE.Vector3;
    /** World-space height of the clone (crown offset for palm FX). */
    height: number;
    shakeTimer: number;
    shakeSeed: number;
  } | null = null;
  /** Felled palms mid-topple → bounce → sink-and-fade (promoted clones, or
   *  just-in-time clones when a REMOTE player felled the tree). */
  readonly harvestFalls: Array<{
    node: THREE.Object3D;
    age: number;
    baseYaw: number;
    fallDirX: number;
    fallDirZ: number;
    trunkHeight: number;
    baseLocalY: number;
    baseWorld: THREE.Vector3;
    impactFired: boolean;
    fadeMats: THREE.Material[] | null;
  }> = [];
  /** Own copy of the 1.4Hz chop-beat edge detector (audioFrameTriggers keeps its own). */
  prevHarvestChopCycle = 1;
  readonly tempHarvestVec = new THREE.Vector3();
  readonly tempHarvestQuatA = new THREE.Quaternion();
  readonly tempHarvestQuatB = new THREE.Quaternion();
  /** True while the axe has a harvestable in range — gates the chop thunk. */
  harvestTargetActive = false;
  readonly windWispMeshes: WindWispRecord[] = [];
  readonly windWisps = new THREE.Group();

  // ── Harvest destruction: promote-on-chop + real breakdown ─────────────────
  // The instanced palm/boulder under the local axe is swapped for a live GLB
  // clone so each strike can shake it and completion can topple/burst it for
  // real instead of the prop silently zero-scaling away.

  /** Nearest choppable palm/boulder within axe range — the SAME nearest-prop
   *  logic the harvest prompt uses, shared so prompt and promotion agree. */
  findHarvestTarget(player: Player): { prop: IslandProp; island: Island } | null {
    if (!this.view.state) return null;
    let bestProp: IslandProp | null = null;
    let bestIsland: Island | null = null;
    let bestD: number = HARVEST.RANGE;
    for (const isl of this.view.state.islands) {
      if (!isl.props?.length) continue;
      if (!isPointInsideIslandFootprint(isl, player.position.x, player.position.z, 8)) continue;
      for (const prop of isl.props) {
        if (!prop.type.startsWith('palm_') && !prop.type.startsWith('boulder_')) continue;
        const d = dist2D(player.position.x, player.position.z, prop.x, prop.z);
        if (d < bestD) {
          bestD = d;
          bestProp = prop;
          bestIsland = isl;
        }
      }
    }
    return bestProp && bestIsland ? { prop: bestProp, island: bestIsland } : null;
  }

  /** Live clone of an instanced prop at its exact registry transform, parented
   *  into the island group (same space the InstancedMesh slots live in).
   *
   *  `propBaseLift` is the SAME sink the scatterer applies to the instance: a
   *  boulder GLB is authored with its lowest vertex up to half a metre above its
   *  origin, so a clone seated on the raw ground height stood taller than the
   *  instance it replaced — the rock visibly hopped on the first axe strike. */
  buildHarvestClone(island: Island, prop: IslandProp): THREE.Object3D | null {
    const slot = prop.id !== undefined ? this.view.islandPropInstances.get(island.id)?.get(prop.id) : undefined;
    const parent = slot?.inst.parent ?? this.view.islandMeshes.get(island.id);
    if (!parent) return null;
    const node = this.view.buildPropInstance(
      prop.type as AssetName,
      new THREE.Vector3(
        prop.x - island.position.x,
        getPropGroundY(island, prop) - propBaseLift(prop.type, prop.scale),
        prop.z - island.position.z,
      ),
      prop.yaw,
      prop.scale,
    );
    if (!node) return null;
    node.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    parent.add(node);
    return node;
  }

  /** Swap the instance for a live clone: zero the instance slot (keeping its
   *  matrix for a clean demote) and stand the clone at the same transform. */
  promoteHarvestProp(island: Island, prop: IslandProp) {
    if (prop.id === undefined) return;
    const slot = this.view.islandPropInstances.get(island.id)?.get(prop.id);
    if (!slot) return;
    const node = this.buildHarvestClone(island, prop);
    if (!node) return;
    const savedMatrix = new THREE.Matrix4();
    slot.inst.getMatrixAt(slot.index, savedMatrix);
    slot.inst.setMatrixAt(slot.index, ZERO_SCALE_MAT4);
    slot.inst.instanceMatrix.needsUpdate = true;
    this.harvestPromoted = {
      islandId: island.id,
      propId: prop.id,
      type: prop.type,
      node,
      savedMatrix,
      basePos: node.position.clone(),
      height: new THREE.Box3().setFromObject(node).getSize(this.tempHarvestVec).y,
      shakeTimer: 0,
      shakeSeed: 0,
    };
  }

  /** Chop abandoned before completion: restore the instance matrix, drop the clone. */
  demotePromotedHarvestProp() {
    const promoted = this.harvestPromoted;
    if (!promoted) return;
    this.harvestPromoted = null;
    const slot = this.view.islandPropInstances.get(promoted.islandId)?.get(promoted.propId);
    if (slot) {
      slot.inst.setMatrixAt(slot.index, promoted.savedMatrix);
      slot.inst.instanceMatrix.needsUpdate = true;
    }
    promoted.node.removeFromParent();
    this.view.disposeSceneObject(promoted.node);
  }

  /** Start a felled palm's topple: away from the harvester when known, else a
   *  random lean. The node animates in updateHarvestDestruction. */
  beginPalmTopple(node: THREE.Object3D, byPlayerId: string | undefined) {
    node.getWorldPosition(this.tempHarvestVec);
    const baseWorld = this.tempHarvestVec.clone();
    const harvester = byPlayerId ? this.view.playersById.get(byPlayerId) : undefined;
    let dirX = harvester ? baseWorld.x - harvester.position.x : 0;
    let dirZ = harvester ? baseWorld.z - harvester.position.z : 0;
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.3) {
      const theta = Math.random() * Math.PI * 2;
      dirX = Math.cos(theta);
      dirZ = Math.sin(theta);
    } else {
      dirX /= len;
      dirZ /= len;
    }
    const height = new THREE.Box3().setFromObject(node).getSize(this.tempHarvestVec).y;
    this.harvestFalls.push({
      node,
      age: 0,
      baseYaw: node.rotation.y,
      fallDirX: dirX,
      fallDirZ: dirZ,
      trunkHeight: Math.max(1.5, height),
      baseLocalY: node.position.y,
      baseWorld,
      impactFired: false,
      fadeMats: null,
    });
  }

  /** Fade prep for the sink phase: clone every material (the GLB library ones
   *  are shared) so opacity can animate; clones are disposed with the node. */
  makeHarvestNodeFadable(node: THREE.Object3D): THREE.Material[] {
    const mats: THREE.Material[] = [];
    node.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.material) return;
      const swap = (material: THREE.Material) => {
        const clone = material.clone();
        clone.transparent = true;
        mats.push(clone);
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    return mats;
  }

  /** Per-frame driver: promote/demote the live chop target, pulse strike FX on
   *  the 1.4Hz swing beat, and play out palm topples. */
  updateHarvestDestruction(dt: number) {
    const player = this.view.getLocalPlayer();
    const chopping = !!player
      && player.equippedTool === 'axe'
      && player.state === 'alive'
      && !player.carryingChestId
      && this.view.input.isFiring();
    const target = chopping && player ? this.findHarvestTarget(player) : null;
    this.harvestTargetActive = !!target;

    if (!target || target.prop.id === undefined) {
      this.demotePromotedHarvestProp();
    } else if (
      !this.harvestPromoted
      || this.harvestPromoted.islandId !== target.island.id
      || this.harvestPromoted.propId !== target.prop.id
    ) {
      this.demotePromotedHarvestProp();
      this.promoteHarvestProp(target.island, target.prop);
    }

    // Strike beat — same clock as the axe viewmodel + playAxeChop (beat at 0.75).
    const chopCycle = (this.view.ocean.getTime() * 1.4) % 1;
    const struck = chopping && chopCycle >= 0.75 && this.prevHarvestChopCycle < 0.75;
    this.prevHarvestChopCycle = chopping ? chopCycle : 1;

    const promoted = this.harvestPromoted;
    if (promoted && player) {
      const isPalm = promoted.type.startsWith('palm_');
      if (struck) {
        promoted.shakeTimer = 0.3;
        promoted.shakeSeed = Math.random() * Math.PI * 2;
        // Strike point: trunk/face height, nudged toward the axe wielder.
        promoted.node.getWorldPosition(this.tempHarvestVec);
        const toX = player.position.x - this.tempHarvestVec.x;
        const toZ = player.position.z - this.tempHarvestVec.z;
        const toLen = Math.hypot(toX, toZ) || 1;
        this.tempHarvestVec.x += (toX / toLen) * 0.4;
        this.tempHarvestVec.z += (toZ / toLen) * 0.4;
        if (isPalm) {
          this.tempHarvestVec.y += 1.1;
          this.view.combatFx.emitWoodChips(this.tempHarvestVec);
          // Frond shiver at the crown.
          this.tempHarvestVec.x -= (toX / toLen) * 0.4;
          this.tempHarvestVec.z -= (toZ / toLen) * 0.4;
          this.tempHarvestVec.y += promoted.height - 1.4;
          this.view.combatFx.emitLeafPuff(this.tempHarvestVec);
        } else {
          this.tempHarvestVec.y += Math.min(0.7, promoted.height * 0.5);
          this.view.combatFx.emitStoneChips(this.tempHarvestVec);
        }
      }
      // Strike impulse: palms whip at the trunk, boulders jitter in place.
      const node = promoted.node;
      if (promoted.shakeTimer > 0) {
        promoted.shakeTimer = Math.max(0, promoted.shakeTimer - dt);
        const k = promoted.shakeTimer / 0.3;
        const wobble = Math.sin((0.3 - promoted.shakeTimer) * 42 + promoted.shakeSeed) * 0.04 * k * k;
        if (isPalm) {
          node.rotation.x = wobble * Math.cos(promoted.shakeSeed);
          node.rotation.z = wobble * Math.sin(promoted.shakeSeed);
        } else {
          node.position.x = promoted.basePos.x + wobble * 0.55;
          node.position.z = promoted.basePos.z + wobble * 0.4;
        }
      } else {
        node.rotation.x = 0;
        node.rotation.z = 0;
        node.position.copy(promoted.basePos);
      }
      // The clone stands INSIDE the island's frozen static subtree (it takes the
      // instanced prop's slot, in the instanced prop's parent), so nothing walks
      // it for us — it refreshes its own world matrix.
      refreshFrozenChild(node);
    }

    // Palm topple playback: ease-in fall (gravity feel) → damped bounce at
    // ~85° → sink 1.5m + fade → gone.
    const TOPPLE = 1.1;
    const BOUNCE = 0.35;
    const SINK = 0.7;
    const FALL_ANGLE = 1.484; // ~85°
    for (let index = this.harvestFalls.length - 1; index >= 0; index--) {
      const fall = this.harvestFalls[index];
      fall.age += dt;
      const node = fall.node;
      let tilt: number;
      if (fall.age < TOPPLE) {
        const t = fall.age / TOPPLE;
        tilt = FALL_ANGLE * t * t * (0.4 + 0.6 * t); // accelerating lean
      } else {
        const s = fall.age - TOPPLE;
        tilt = FALL_ANGLE - Math.abs(Math.sin(s * 16)) * 0.06 * Math.exp(-s * 7);
        if (!fall.impactFired) {
          fall.impactFired = true;
          // Crown slams down trunkHeight out along the fall direction.
          this.tempHarvestVec.set(
            fall.baseWorld.x + fall.fallDirX * fall.trunkHeight * 0.9,
            fall.baseWorld.y + 0.3,
            fall.baseWorld.z + fall.fallDirZ * fall.trunkHeight * 0.9,
          );
          this.view.combatFx.emitLeafPuff(this.tempHarvestVec, 10);
          this.view.combatFx.emitTreeFallImpact(this.tempHarvestVec, fall.baseWorld.y);
          this.view.audio.playTreeFallThud(this.view.renderer.camera.position.distanceTo(this.tempHarvestVec));
        }
      }
      // Tip about the base: tilt axis ⊥ fall direction, composed over the yaw.
      this.tempHarvestVec.set(fall.fallDirZ, 0, -fall.fallDirX);
      this.tempHarvestQuatA.setFromAxisAngle(this.tempHarvestVec, tilt);
      this.tempHarvestVec.set(0, 1, 0);
      this.tempHarvestQuatB.setFromAxisAngle(this.tempHarvestVec, fall.baseYaw);
      node.quaternion.multiplyQuaternions(this.tempHarvestQuatA, this.tempHarvestQuatB);
      let gone = false;
      if (fall.age >= TOPPLE + BOUNCE) {
        const sinkT = Math.min(1, (fall.age - TOPPLE - BOUNCE) / SINK);
        if (!fall.fadeMats) fall.fadeMats = this.makeHarvestNodeFadable(node);
        node.position.y = fall.baseLocalY - 1.5 * sinkT;
        for (const material of fall.fadeMats) material.opacity = 1 - sinkT;
        if (sinkT >= 1) {
          node.removeFromParent();
          this.view.disposeSceneObject(node);
          this.harvestFalls.splice(index, 1);
          gone = true;
        }
      }
      // Same as the promoted clone: a falling palm lives inside the island's
      // frozen static subtree, so it pushes its own world matrix.
      if (!gone) refreshFrozenChild(node);
    }
  }

  // ── Island lantern / campfire warm-light budget ──────────────────────────
  // Shared point-light pools (added once, reused across matches) plus per-emitter
  // additive glow / flame sprites. The nearest N of each kind are lit for real at
  // night; everything else is a cheap sprite. See updateLanterns().
  initLanternSystem() {
    this.lanternGlowTexture = makeLanternGlowTexture();
    this.lanternFlameTexture = makeLanternFlameTexture();
    for (let i = 0; i < 6; i++) {
      const light = new THREE.PointLight(0xffb257, 0, 24, 1.6);
      light.visible = false;
      registerBudgetLight(light);
      this.lanternRoot.add(light);
      this.lanternLightPool.push(light);
    }
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xff7a30, 0, 21, 1.5);
      light.visible = false;
      registerBudgetLight(light);
      this.lanternRoot.add(light);
      this.campfireLightPool.push(light);
    }
    this.view.renderer.scene.add(this.lanternRoot);
  }

  /** Register a warm island light. `container` is an island sub-group (dock/camp/
   *  tavern/cave); the anchor tracks its transform so world positions stay correct. */
  registerLanternEmitter(
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

  updateLanterns(nf: number, cameraPos: THREE.Vector3, t: number) {
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
        light.intensity = nf * 2.1 * flicker;
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
        light.intensity = nf * 2.5 * Math.max(0.25, flicker);
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
  assignLanternBudget(emitters: LanternEmitter[], assigned: LanternEmitter[], budget: number) {
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

  clearLanternEmitters() {
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

  /** Island builder seam: hand over every fall this island grew (replaces the
   *  island's previous set, so a rebuild never doubles them up). */
  registerWaterfalls(islandId: string, sites: { x: number; y: number; z: number; scale: number }[]) {
    if (sites.length === 0) this.waterfallSites.delete(islandId);
    else this.waterfallSites.set(islandId, sites);
  }

  /** Feed the audio bed with the nearest fall. Cheap: a few dozen distance
   *  checks over emitters that never move. */
  updateWaterfallBed(cameraPos: THREE.Vector3) {
    if (this.waterfallSites.size === 0) {
      this.view.audio.setWaterfallBed(null);
      return;
    }
    let bestD = Infinity;
    let bestScale = 1;
    for (const sites of this.waterfallSites.values()) {
      for (const site of sites) {
        const dx = site.x - cameraPos.x;
        const dy = site.y - cameraPos.y;
        const dz = site.z - cameraPos.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestD) { bestD = d; bestScale = site.scale; }
      }
    }
    this.view.audio.setWaterfallBed(bestD <= 130 ? bestD : null, bestScale);
  }

  updateVolcanicFx(dt: number, worldTime: number) {
    if (this.volcanicFx.length === 0) return;
    // Warm flicker in ~[0.55, 1.1]: a slow throb plus a faster shimmer.
    const throb = Math.sin(worldTime * 1.6) * 0.5 + 0.5;
    const shimmer = Math.sin(worldTime * 7.3 + 1.7) * 0.5 + 0.5;
    this.view.magmaPulseUniform.value = 0.62 + throb * 0.34 + shimmer * 0.08;
    const cam = this.view.renderer.camera.position;
    for (const fx of this.volcanicFx) fx(dt, worldTime, cam);
  }

  initWindWisps() {
    if (this.windWispMeshes.length > 0) return;

    const geometry = new THREE.PlaneGeometry(3.1, 0.22);
    const count = this.view.renderer.getQuality() === 'low' ? 0 : this.view.renderer.getQuality() === 'balanced' ? 4 : 8;
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

  updateWindWisps() {
    if (this.windWispMeshes.length === 0) {
      this.windWisps.visible = false;
      return;
    }
    const player = this.view.getLocalPlayer();
    if (!player) {
      this.windWisps.visible = false;
      return;
    }

    const trackedShip = this.view.getTrackedShip();
    const time = this.view.ocean.getTime();
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

  /** The bolt's directional pulse — everything in the scene flash-lit from the
   *  strike's bearing. Allocated HERE, at startup, and never removed: the
   *  directional-light count is baked into every shader program, so building it
   *  on the first strike re-linked the whole scene mid-storm (measured as a
   *  ~150ms hitch on the first bolt). The bottom tier never gets one — the sky
   *  flash, the ribbon and the screen pulse carry the strike without it. */
  private setupLightningPulse() {
    if (this.boltLight || this.view.renderer.getQuality() === 'low') return;
    this.boltLight = new THREE.DirectionalLight(0xc3daff, 0);
    this.view.renderer.scene.add(this.boltLight);
    this.view.renderer.scene.add(this.boltLight.target);
  }

  setupStormWeatherOverlay() {
    this.setupLightningPulse();
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

  computeStormWeatherIntensity(): number {
    if (!this.view.state) return 0;
    const player = this.view.getLocalPlayer();
    if (!player) return 0;
    const dist = dist2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ);

    const safeRadius = Math.max(1, this.view.state.storm.safeRadius);
    const phase = this.view.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);
    const phaseBoost = Math.min(1, phase / maxPhase) * 0.2;
    const shrinkBoost = this.view.state.storm.shrinking ? 0.08 + this.view.state.storm.shrinkProgress * 0.08 : 0;

    // Crossfade across a ±30m band at the wall — weather used to snap from
    // 0.24 to 0.52+ the frame you crossed the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -30, 30);
    const stormDepth = THREE.MathUtils.clamp(distOutside / 240, 0, 1);
    const edgeFade = THREE.MathUtils.clamp((dist / safeRadius - 0.84) / 0.16, 0, 1);
    const insideIntensity = Math.min(0.24, edgeFade * 0.14 + shrinkBoost * 0.45);
    const outsideIntensity = Math.min(1, 0.52 + phaseBoost + shrinkBoost + stormDepth * 0.32);
    const base = THREE.MathUtils.lerp(insideIntensity, outsideIntensity, outsideBlend);

    // A SHOWER CARRIES ITS OWN SKY.
    //
    // The rain reaches ~150 m inboard of the wall on purpose, so sailing up to a
    // squall means a wet approach rather than a dry frame followed by a wall of
    // water. But only the RAIN reached in: the sky number stayed near 0.10 out
    // there, so drops fell through cloudless noon blue — the single most
    // dream-logic frame in the game. The overcast now reaches inboard on the
    // same ramp the rain does, a little ahead of it, so the cloud arrives first
    // and the drops fall out of something.
    const wallOvercast = this.stormWallNearness() * (0.34 + (phase / maxPhase) * 0.14);
    return Math.max(base, wallOvercast);
  }

  /** 0 = far from the storm boundary, 1 = at it. Shared by the rain and the
   *  overcast so a squall's water and its cloud arrive on the same ramp. */
  private stormWallNearness(): number {
    const wallDist = this.cameraDistanceToStormWall();
    return wallDist < 0 ? 0 : 1 - THREE.MathUtils.smoothstep(wallDist, 30, 165);
  }

  computeStormRainIntensity(): number {
    if (!this.view.state) return 0;
    const player = this.view.getLocalPlayer();
    if (!player) return 0;

    const dist = dist2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ);
    const safeRadius = Math.max(1, this.view.state.storm.safeRadius);
    const phase = this.view.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);

    // Rain builds across the wall band instead of popping on at the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -25, 35);
    const stormDepth = THREE.MathUtils.clamp(distOutside / 220, 0, 1);
    const shrinkBoost = this.view.state.storm.shrinking ? 0.08 : 0;
    const fromPlayer = outsideBlend <= 0.001
      ? 0
      : Math.min(1, 0.34 + stormDepth * 0.42 + (phase / maxPhase) * 0.2 + shrinkBoost) * outsideBlend;

    // Weather AT the wall. Sailing up to the boundary from the safe side used to
    // put you a few metres from a squall line in dead-still air with a dry deck:
    // the rain only existed once you had crossed. The squall reaches inboard of
    // its own edge, so the drops (and the rain audio, which rides the same
    // number) fade in over the last ~150m of the approach.
    const wallFloor = this.stormWallNearness() * (0.30 + (phase / maxPhase) * 0.16);
    const wanted = Math.max(fromPlayer, wallFloor);

    // Hard gate on the sky above: rain may never outrun the cloud that is
    // supposed to be producing it. The overcast reaches inboard on the same
    // ramp (see computeStormWeatherIntensity), so this only bites where the two
    // ramps disagree — and there it is the drops that give way, not the sky.
    const skyCap = Math.min(1, this.computeStormWeatherIntensity() * 1.3);
    return Math.min(wanted, skyCap);
  }

  // ── Storm rain ────────────────────────────────────────────────────────────
  // World-space, depth-layered rain: 1–3 camera-relative shells of line-segment
  // drops, all sharing one wind field with travelling gust bands, plus an
  // instanced splash pool where those streaks meet sea / deck / terrain, a haze
  // curtain that thickens the distance, and cover occlusion so caves and the
  // hold stay dry. Nothing in the loop allocates.

  private rainShells: RainShell[] | null = null;
  private rainHaze: THREE.Mesh | null = null;
  private splash: SplashPool | null = null;
  /** 0 = out in the weather, 1 = fully sheltered. Eased, so walking into a cave
   *  mouth fades the rain out instead of cutting it. */
  private rainCover = 0;
  private splashAccum = 0;
  // Per-frame gust LUT (recomputed per shell): drift velocity, streak vector and
  // the density gate for each along-wind band.
  private readonly bandWindX = new Float32Array(RAIN_BANDS);
  private readonly bandWindZ = new Float32Array(RAIN_BANDS);
  private readonly bandStreakX = new Float32Array(RAIN_BANDS);
  private readonly bandStreakY = new Float32Array(RAIN_BANDS);
  private readonly bandStreakZ = new Float32Array(RAIN_BANDS);
  private readonly bandGate = new Float32Array(RAIN_BANDS);
  private readonly rainVec = new THREE.Vector3();
  private readonly rainScale = new THREE.Vector3(1, 1, 1);
  private readonly rainMat4 = new THREE.Matrix4();
  private readonly rainFlatQuat = new THREE.Quaternion();
  private readonly rainColor = new THREE.Color();
  private readonly rainShipLocal = { x: 0, z: 0 };
  /** Scratch for sampleImpactSurface — avoids a per-splash object. */
  private impactY = 0;
  private impactOnShip = false;
  private readonly rainShipQuat = new THREE.Quaternion();
  /** Cached RENDERED hull group (`ship_<id>`). Deck splashes are stored in this
   *  node's local space, so they ride the real heave/pitch/roll the hull is
   *  drawn with — the replicated ship.position lags it by up to a couple of
   *  metres of client heave. */
  private deckShipNode: THREE.Object3D | null = null;
  private deckShipId = '';

  /** Rendered hull node for the ship the local player is riding, or null. */
  private getDeckShipNode(): THREE.Object3D | null {
    const ship = this.view.getTrackedShip();
    if (!ship || ship.sinking) {
      this.deckShipNode = null;
      this.deckShipId = '';
      return null;
    }
    if (this.deckShipId !== ship.id || !this.deckShipNode || !this.deckShipNode.parent) {
      this.deckShipNode = this.view.renderer.scene.getObjectByName(`ship_${ship.id}`) ?? null;
      this.deckShipId = this.deckShipNode ? ship.id : '';
    }
    return this.deckShipNode;
  }

  private makeSplashRingTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.00, 'rgba(214,234,255,0.30)');
    g.addColorStop(0.46, 'rgba(214,234,255,0.05)');
    g.addColorStop(0.74, 'rgba(232,244,255,0.85)');
    g.addColorStop(0.90, 'rgba(232,244,255,0.30)');
    g.addColorStop(1.00, 'rgba(232,244,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private makeSplashDropletTexture(): THREE.CanvasTexture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, 'rgba(240,248,255,0.95)');
    g.addColorStop(0.5, 'rgba(214,234,255,0.45)');
    g.addColorStop(1.0, 'rgba(214,234,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private makeRainHazeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0.00, 'rgba(178,193,208,0.00)');
    g.addColorStop(0.34, 'rgba(178,193,208,0.55)');
    g.addColorStop(0.78, 'rgba(190,204,218,0.95)');
    g.addColorStop(1.00, 'rgba(196,210,224,0.20)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(6, 1);
    return tex;
  }

  private ensureRainShells(): RainShell[] {
    if (this.rainShells) return this.rainShells;
    const tier = RAIN_TIERS[this.view.renderer.getQuality()];
    const shells: RainShell[] = [];
    for (const specIndex of tier.shells) {
      const spec = RAIN_SHELL_SPECS[specIndex];
      const drops = Math.max(48, Math.round(spec.drops * tier.scale));
      const pos = new Float32Array(drops * 6);
      const colors = new Float32Array(drops * 8);
      const hash = new Float32Array(drops);
      for (let i = 0; i < drops; i++) {
        // Golden-angle spiral seeding: even disc coverage without clumping.
        const a = (i * 2.399963) % (Math.PI * 2);
        const rad = spec.radius * Math.sqrt(((i * 7919) % 1024) / 1024);
        const o = i * 6;
        pos[o] = Math.cos(a) * rad;
        pos[o + 1] = ((i * 37) % 240) / 240 * spec.ceiling * 2 - spec.ceiling * 0.5;
        pos[o + 2] = Math.sin(a) * rad;
        pos[o + 3] = pos[o];
        pos[o + 4] = pos[o + 1] + 0.4;
        pos[o + 5] = pos[o + 2];
        const h = ((i * 2654435761) % 1024) / 1024;
        hash[i] = h;
        // Head bright, tail nearly gone: the alpha taper along the segment IS
        // the motion blur — a falling drop smears out behind its leading edge.
        const bright = 0.72 + h * 0.5;
        const c = i * 8;
        colors[c] = 0.86; colors[c + 1] = 0.92; colors[c + 2] = 1.0; colors[c + 3] = bright;
        colors[c + 4] = 0.74; colors[c + 5] = 0.84; colors[c + 6] = 1.0; colors[c + 7] = bright * 0.12;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      const material = new THREE.LineBasicMaterial({
        color: 0xcfe0f4,
        vertexColors: true,
        transparent: true,
        opacity: spec.opacity,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(geo, material);
      lines.frustumCulled = false;
      lines.renderOrder = 8;
      lines.visible = false;
      this.view.renderer.scene.add(lines);
      shells.push({
        lines, material, geo, pos, colorArr: colors, hash, drops,
        radius: spec.radius,
        ceiling: spec.ceiling,
        streak: spec.streak,
        speed: spec.speed,
        opacity: spec.opacity,
        gustPhase: spec.gustPhase,
      });
    }

    // Haze curtain: a soft depth-tested veil at mid range so distance reads wet.
    const hazeGeo = new THREE.CylinderGeometry(96, 96, 130, 24, 1, true);
    const haze = new THREE.Mesh(hazeGeo, new THREE.MeshBasicMaterial({
      map: this.makeRainHazeTexture(),
      color: 0xb9c8d6,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    }));
    haze.renderOrder = 7;
    haze.frustumCulled = false;
    haze.visible = false;
    this.view.renderer.scene.add(haze);
    this.rainHaze = haze;

    this.rainShells = shells;
    this.ensureSplashPool();
    return shells;
  }

  private ensureSplashPool(): SplashPool {
    if (this.splash) return this.splash;
    const quality = this.view.renderer.getQuality();
    const ringCount = quality === 'low' ? 28 : quality === 'balanced' ? 90 : 150;
    const dropletCount = quality === 'low' ? 0 : quality === 'balanced' ? 140 : 260;

    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2); // rings lie flat on whatever they landed on
    const rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({
      map: this.makeSplashRingTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }), ringCount);
    rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    rings.frustumCulled = false;
    rings.renderOrder = 9;
    rings.visible = false;
    this.view.renderer.scene.add(rings);

    const droplets = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.makeSplashDropletTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }), Math.max(1, dropletCount));
    droplets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    droplets.frustumCulled = false;
    droplets.renderOrder = 9;
    droplets.visible = false;
    this.view.renderer.scene.add(droplets);

    for (let i = 0; i < ringCount; i++) rings.setMatrixAt(i, ZERO_SCALE_MAT4);
    for (let i = 0; i < dropletCount; i++) droplets.setMatrixAt(i, ZERO_SCALE_MAT4);

    this.splash = {
      rings, droplets, ringCount, dropletCount,
      ring: new Float32Array(ringCount * 4),
      ringLife: new Float32Array(ringCount),
      ringSize: new Float32Array(ringCount),
      ringOnShip: new Uint8Array(ringCount),
      ringCursor: 0,
      droplet: new Float32Array(Math.max(1, dropletCount) * 7),
      dropletLife: new Float32Array(Math.max(1, dropletCount)),
      dropletSize: new Float32Array(Math.max(1, dropletCount)),
      dropletCursor: 0,
    };
    return this.splash;
  }

  /** Cover test for the camera: inside a cave interior, or below decks under
   *  the weather deck. Returns the target, not the eased value. */
  private computeRainCoverTarget(): number {
    const cam = this.view.renderer.camera.position;
    // Under the surface there is no falling rain to see.
    if (cam.y < this.view.ocean.getSurfaceY(cam.x, cam.z) - 0.1) return 1;
    const state = this.view.state;
    if (state) {
      for (const island of state.islands) {
        if (!island.caves || island.caves.length === 0) continue;
        if (dist2D(cam.x, cam.z, island.position.x, island.position.z) > getIslandMaxRadius(island)) continue;
        if (isInsideCaveInterior(island, cam.x, cam.y, cam.z)) return 1;
      }
    }
    const ship = this.view.getTrackedShip();
    const player = this.view.getLocalPlayer();
    if (ship && player?.onShipId === ship.id) {
      const stats = SHIP_STATS[ship.type];
      const dx = cam.x - ship.position.x;
      const dz = cam.z - ship.position.z;
      const cos = Math.cos(ship.rotation);
      const sin = Math.sin(ship.rotation);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) < stats.width * 0.52 && Math.abs(lz) < stats.length * 0.48
        && cam.y < getShipDeckY(ship.position.y, stats) - 0.55) {
        return 1;
      }
    }
    return 0;
  }

  /** Where does a drop falling at (x, z) actually land? Deck beats terrain
   *  beats sea. Writes impactY / impactOnShip; returns false when the surface is
   *  too far above or below the camera to be worth a splash. */
  private sampleImpactSurface(x: number, z: number, camY: number): boolean {
    this.impactOnShip = false;
    const ship = this.view.getTrackedShip();
    const node = this.getDeckShipNode();
    if (ship && node) {
      const stats = SHIP_STATS[ship.type];
      // Hull-local XZ from the DRAWN transform (yaw dominates; the few degrees
      // of pitch/roll shift the footprint test by centimetres).
      const dx = x - node.position.x;
      const dz = z - node.position.z;
      const cos = Math.cos(node.rotation.y);
      const sin = Math.sin(node.rotation.y);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) < stats.width * 0.46 && Math.abs(lz) < stats.length * 0.44) {
        this.rainShipLocal.x = lx;
        this.rainShipLocal.z = lz;
        // Hull-LOCAL standing plane: the deck slabs' top face (see ShipRenderer).
        this.impactY = getShipDeckY(0, stats) + getShipDeckRaiseAt(this.rainShipLocal, stats);
        this.impactOnShip = true;
        return Math.abs(node.position.y + this.impactY - camY) < 26;
      }
    }
    const seaY = this.view.ocean.getSurfaceY(x, z);
    const state = this.view.state;
    if (state) {
      for (const island of state.islands) {
        if (dist2D(x, z, island.position.x, island.position.z) > getIslandMaxRadius(island)) continue;
        const groundY = getIslandSurfaceY(island, x, z);
        if (groundY > seaY + 0.05) {
          this.impactY = groundY;
          return Math.abs(groundY - camY) < 26;
        }
      }
    }
    this.impactY = seaY;
    return Math.abs(seaY - camY) < 26;
  }

  private spawnSplash(x: number, z: number, camY: number) {
    const pool = this.splash;
    if (!pool || !this.sampleImpactSurface(x, z, camY)) return;
    const onShip = this.impactOnShip;
    const node = onShip ? this.deckShipNode : null;
    // World height of the impact — hull-local for deck hits, absolute otherwise.
    const y = node ? node.position.y + this.impactY : this.impactY;

    const r = pool.ringCursor;
    pool.ringCursor = (r + 1) % pool.ringCount;
    const ro = r * 4;
    if (onShip) {
      // Deck rings live in HULL-LOCAL space so they ride heave, pitch and roll.
      pool.ring[ro] = this.rainShipLocal.x;
      pool.ring[ro + 1] = this.impactY;
      pool.ring[ro + 2] = this.rainShipLocal.z;
    } else {
      pool.ring[ro] = x;
      pool.ring[ro + 1] = y;
      pool.ring[ro + 2] = z;
    }
    pool.ring[ro + 3] = 0;
    pool.ringLife[r] = 0.30 + Math.random() * 0.16;
    pool.ringSize[r] = onShip ? 0.14 + Math.random() * 0.13 : 0.20 + Math.random() * 0.20;
    pool.ringOnShip[r] = onShip ? 1 : 0;

    if (pool.dropletCount === 0) return;
    const bounces = 2 + (Math.random() < 0.45 ? 1 : 0);
    for (let b = 0; b < bounces; b++) {
      const d = pool.dropletCursor;
      pool.dropletCursor = (d + 1) % pool.dropletCount;
      const dof = d * 7;
      const theta = Math.random() * Math.PI * 2;
      const lateral = 0.5 + Math.random() * 1.1;
      pool.droplet[dof] = x;
      pool.droplet[dof + 1] = y + 0.03;
      pool.droplet[dof + 2] = z;
      pool.droplet[dof + 3] = Math.cos(theta) * lateral;
      pool.droplet[dof + 4] = 1.7 + Math.random() * 1.9;
      pool.droplet[dof + 5] = Math.sin(theta) * lateral;
      pool.droplet[dof + 6] = 0;
      pool.dropletLife[d] = 0.28 + Math.random() * 0.2;
      pool.dropletSize[d] = 0.035 + Math.random() * 0.04;
    }
  }

  private updateSplashes(dt: number) {
    const pool = this.splash;
    if (!pool) return;
    let anyRing = false;
    const node = this.deckShipNode;
    if (node) {
      node.updateWorldMatrix(false, false);
      node.getWorldQuaternion(this.rainShipQuat);
    }

    for (let i = 0; i < pool.ringCount; i++) {
      const life = pool.ringLife[i];
      if (life <= 0) continue;
      const o = i * 4;
      const age = pool.ring[o + 3] + dt;
      if (age >= life) {
        pool.ringLife[i] = 0;
        pool.rings.setMatrixAt(i, ZERO_SCALE_MAT4);
        continue;
      }
      pool.ring[o + 3] = age;
      const t = age / life;
      let flat = true;
      if (pool.ringOnShip[i] === 1) {
        if (!node) {
          pool.ringLife[i] = 0;
          pool.rings.setMatrixAt(i, ZERO_SCALE_MAT4);
          continue;
        }
        this.rainVec.set(pool.ring[o], pool.ring[o + 1] + 0.03, pool.ring[o + 2])
          .applyMatrix4(node.matrixWorld);
        flat = false; // ring lies in the DECK plane, tilting with the hull
      } else {
        this.rainVec.set(pool.ring[o], pool.ring[o + 1] + 0.02, pool.ring[o + 2]);
      }
      // Ring expands fast then eases. It is additive, so per-instance colour
      // brightness IS its fade — no per-instance alpha channel needed.
      const grow = pool.ringSize[i] * (0.18 + t * (1.6 - t * 0.55));
      const fade = (1 - t) * (1 - t);
      this.rainScale.set(grow, grow, grow);
      this.rainMat4.compose(this.rainVec, flat ? this.rainFlatQuat : this.rainShipQuat, this.rainScale);
      pool.rings.setMatrixAt(i, this.rainMat4);
      this.rainColor.setScalar(0.35 + fade * 0.75);
      pool.rings.setColorAt(i, this.rainColor);
      anyRing = true;
    }
    pool.rings.instanceMatrix.needsUpdate = true;
    if (pool.rings.instanceColor) pool.rings.instanceColor.needsUpdate = true;
    pool.rings.visible = anyRing;

    if (pool.dropletCount === 0) return;
    let anyDroplet = false;
    const camQuat = this.view.renderer.camera.quaternion;
    for (let i = 0; i < pool.dropletCount; i++) {
      const life = pool.dropletLife[i];
      if (life <= 0) continue;
      const o = i * 7;
      const age = pool.droplet[o + 6] + dt;
      if (age >= life) {
        pool.dropletLife[i] = 0;
        pool.droplets.setMatrixAt(i, ZERO_SCALE_MAT4);
        continue;
      }
      pool.droplet[o + 6] = age;
      pool.droplet[o + 4] -= 11 * dt; // ballistic arc
      pool.droplet[o] += pool.droplet[o + 3] * dt;
      pool.droplet[o + 1] += pool.droplet[o + 4] * dt;
      pool.droplet[o + 2] += pool.droplet[o + 5] * dt;
      const tt = age / life;
      const shrink = pool.dropletSize[i] * (1 - tt * 0.55);
      this.rainVec.set(pool.droplet[o], pool.droplet[o + 1], pool.droplet[o + 2]);
      this.rainScale.set(shrink, shrink, shrink);
      this.rainMat4.compose(this.rainVec, camQuat, this.rainScale);
      pool.droplets.setMatrixAt(i, this.rainMat4);
      this.rainColor.setScalar(0.5 + (1 - tt) * 0.7);
      pool.droplets.setColorAt(i, this.rainColor);
      anyDroplet = true;
    }
    pool.droplets.instanceMatrix.needsUpdate = true;
    if (pool.droplets.instanceColor) pool.droplets.instanceColor.needsUpdate = true;
    pool.droplets.visible = anyDroplet;
  }

  /** Eased shelter factor (0 = out in it, 1 = fully covered). Probe hook for the
   *  headless cave/below-deck occlusion shots. */
  debugRainCover(): number {
    return this.rainCover;
  }

  // ── Storm front ───────────────────────────────────────────────────────────
  private stormFront: THREE.Mesh | null = null;
  private stormFrontMat: THREE.ShaderMaterial | null = null;

  /** Built on first use rather than at boot: the shell only ever exists in a
   *  match, and building it lazily keeps it off the loading path. */
  private ensureStormFront(): THREE.Mesh {
    if (this.stormFront) return this.stormFront;
    const cheap = this.view.renderer.getQuality() === 'low';
    const geo = new THREE.CylinderGeometry(1, 1, FRONT_HEIGHT, cheap ? 64 : 128, 1, true);
    const mat = new THREE.ShaderMaterial({
      vertexShader: STORM_FRONT_VERT,
      fragmentShader: STORM_FRONT_FRAG,
      defines: cheap ? { FRONT_CHEAP: '' } : {},
      uniforms: {
        u_cam: { value: new THREE.Vector3() },
        u_time: { value: 0 },
        u_intensity: { value: 0 },
        u_night: { value: 0 },
        u_horizon: { value: new THREE.Color(0xc7e6fa) },
        u_fog: { value: new THREE.Color(0x7ba3bd) },
        u_flash: { value: 0 },
        u_flashDir: { value: new THREE.Vector2(0, 1) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // The front IS the ring now — the flat textured wall/halo cylinders it used
    // to paint over are gone. This order only has to keep it under the near-field
    // rain (lines/haze/rings at 7-9), which falls in front of the bank.
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.view.renderer.scene.add(mesh);
    this.stormFront = mesh;
    this.stormFrontMat = mat;
    return mesh;
  }

  /** How developed the front is: always present (the ring is always there), but
   *  it thickens with the phase and while the ring is actively closing. */
  private computeStormFrontIntensity(): number {
    if (!this.view.state) return 0;
    const storm = this.view.state.storm;
    const maxPhase = Math.max(1, STORM_PHASES.length - 1);
    const phase01 = THREE.MathUtils.clamp(storm.phase / maxPhase, 0, 1);
    return Math.min(1, 0.62 + phase01 * 0.32 + (storm.shrinking ? 0.06 : 0));
  }

  /** Distance from the camera to the ring wall (positive either side), or -1
   *  when there is no ring. Used by the rain floor at the boundary. */
  private cameraDistanceToStormWall(): number {
    if (!this.view.state) return -1;
    const storm = this.view.state.storm;
    const cam = this.view.renderer.camera.position;
    const radius = Math.max(1, storm.safeRadius);
    return Math.abs(dist2D(cam.x, cam.z, storm.centerX, storm.centerZ) - radius);
  }

  private updateStormFront() {
    if (!this.view.state) {
      if (this.stormFront) this.stormFront.visible = false;
      return;
    }
    const storm = this.view.state.storm;
    const radius = Math.max(16, storm.safeRadius);
    const mesh = this.ensureStormFront();
    const mat = this.stormFrontMat!;
    // Sits a hair OUTSIDE the safe radius — the boundary you are judged against
    // stays a hair inside the weather you can see — and low enough that storm
    // troughs can't open a gap under it.
    mesh.position.set(storm.centerX, FRONT_HEIGHT * 0.5 - FRONT_BASE_DROP, storm.centerZ);
    mesh.scale.set(radius * 1.006, 1, radius * 1.006);
    const atmosphere = this.view.renderer.getAtmosphere();
    const u = mat.uniforms;
    u.u_cam.value.copy(this.view.renderer.camera.position);
    u.u_time.value = this.view.ocean.getTime();
    u.u_intensity.value = this.computeStormFrontIntensity();
    u.u_night.value = atmosphere.nightFactor;
    (u.u_horizon.value as THREE.Color).copy(atmosphere.horizonColor);
    (u.u_fog.value as THREE.Color).copy(atmosphere.fogColor);
    // The strike lights the bank from inside — same envelope the sky dome and
    // the sea glint already run off, so all three flash on the same frame.
    u.u_flash.value = this.boltEnvelope(this.boltAge);
    (u.u_flashDir.value as THREE.Vector2).set(this.boltDirX, this.boltDirZ);
    mesh.visible = u.u_intensity.value > 0.01;
  }

  updateStormRain3D(dt: number, intensity: number) {
    // The boundary's cloud bank / rain curtain is weather that exists whether or
    // not the LOCAL player is standing in the rain, so it is driven here (the one
    // weather hook that runs every frame) ahead of the density early-out below.
    this.updateStormFront();

    // Clear the legacy canvas overlay once (kept in the DOM for compatibility).
    if (this.stormRainCanvas && this.stormRainCtx && this.stormRainCanvas.width > 0) {
      this.stormRainCtx.clearRect(0, 0, this.stormRainCanvas.width, this.stormRainCanvas.height);
      this.stormRainCanvas.width = 0;
    }

    // Ease the cover state either way so a cave mouth fades rather than cuts.
    const coverTarget = intensity > 0.001 ? this.computeRainCoverTarget() : 0;
    this.rainCover += (coverTarget - this.rainCover) * Math.min(1, dt * 4.5);
    const cover = this.rainCover;
    // Rain audio ramps LINEARLY with rain01 (SoundEngine.setRain) — the visual
    // density, opacity and mist follow the same curve so eyes and ears agree.
    const wet = intensity * (1 - cover);
    this.view.renderer.setRainMist(wet * 0.8);

    if (intensity <= 0.001) {
      if (this.rainShells) for (const shell of this.rainShells) shell.lines.visible = false;
      if (this.rainHaze) this.rainHaze.visible = false;
      if (this.splash) {
        this.splash.rings.visible = false;
        this.splash.droplets.visible = false;
      }
      return;
    }

    const shells = this.ensureRainShells();
    const cam = this.view.renderer.camera.position;
    const t = this.view.ocean.getTime();
    const wind = sampleWind(t);
    const dirX = Math.sin(wind.direction);
    const dirZ = Math.cos(wind.direction);
    const windSpeed = (6 + intensity * 13) * wind.strength;
    const nightFactor = this.view.renderer.getAtmosphere().nightFactor ?? 0;
    const visible = 1 - cover;

    for (const shell of shells) {
      const fallSpeed = (20 + intensity * 12) * shell.speed;
      const streakLen = shell.streak * (0.5 + intensity * 0.75);
      // Bake this shell's travelling gust bands into the along-wind LUT.
      const scroll1 = t * 1.55 + shell.gustPhase;
      const scroll2 = t * 0.62 + shell.gustPhase * 1.7;
      for (let b = 0; b < RAIN_BANDS; b++) {
        const along = b * RAIN_BAND_METRES;
        const g1 = 0.5 + 0.5 * Math.sin(along * RAIN_GUST_K1 - scroll1);
        const g2 = 0.5 + 0.5 * Math.sin(along * RAIN_GUST_K2 - scroll2);
        const g = g1 * 0.62 + g2 * 0.38;
        // Gusts shear the fall: hard bands blow the streaks over and pack them
        // tighter; lulls between them stand the rain back up and thin it out.
        const gustSpeed = windSpeed * (0.28 + 1.65 * g);
        const wx = dirX * gustSpeed;
        const wz = dirZ * gustSpeed;
        const len = Math.hypot(wx, wz, fallSpeed);
        const sLen = streakLen * (0.55 + 1.0 * g);
        this.bandWindX[b] = wx;
        this.bandWindZ[b] = wz;
        this.bandStreakX[b] = (wx / len) * sLen;
        this.bandStreakY[b] = (fallSpeed / len) * sLen;
        this.bandStreakZ[b] = (wz / len) * sLen;
        this.bandGate[b] = 0.10 + 0.90 * g;
      }

      const pos = shell.pos;
      const hash = shell.hash;
      // Per-drop distance fade. Every streak used to be drawn at the same alpha
      // whatever its range, so a downpour read as a screen decal pasted over a
      // 300m horizon rather than as weather falling through the world. Fading
      // the far half of each shell out gives the curtain depth and stops the
      // outermost shell ending on a visible edge.
      const colors = shell.colorArr;
      // Hard ceiling per tier on top of the density curve. Every active drop is
      // a CPU-integrated line segment plus a re-upload of its two vertices, so
      // a full downpour on a fanless laptop was the storm's whole cost; the
      // floor keeps rain visibly falling, the ceiling keeps it affordable.
      const active = Math.min(
        RAIN_ACTIVE_CEILING[this.view.renderer.getQuality()],
        Math.max(24, Math.floor(shell.drops * (0.28 + intensity * 0.72))),
      );
      const radiusSq = shell.radius * shell.radius * 1.85;
      const floorY = cam.y - shell.ceiling * 0.55;
      const spawnDrift = shell.radius * 0.28;
      for (let i = 0; i < active; i++) {
        const o = i * 6;
        let x = pos[o];
        let y = pos[o + 1];
        let z = pos[o + 2];
        const band = (((x * dirX + z * dirZ) * RAIN_INV_BAND) | 0) & (RAIN_BANDS - 1);
        x += this.bandWindX[band] * dt;
        y -= fallSpeed * dt;
        z += this.bandWindZ[band] * dt;
        const dx = x - cam.x;
        const dz = z - cam.z;
        if (y < floorY || dx * dx + dz * dz > radiusSq) {
          const a = Math.random() * Math.PI * 2;
          const rad = shell.radius * Math.sqrt(Math.random());
          // Bias upwind so the slanted fall carries drops across the view.
          x = cam.x + Math.cos(a) * rad - dirX * spawnDrift;
          z = cam.z + Math.sin(a) * rad - dirZ * spawnDrift;
          y = cam.y + shell.ceiling * (0.55 + Math.random() * 0.45);
        }
        pos[o] = x;
        pos[o + 1] = y;
        pos[o + 2] = z;
        if (hash[i] < this.bandGate[band]) {
          const jitter = 0.72 + hash[i] * 0.6;
          pos[o + 3] = x - this.bandStreakX[band] * jitter;
          pos[o + 4] = y + this.bandStreakY[band] * jitter;
          pos[o + 5] = z - this.bandStreakZ[band] * jitter;
        } else {
          // Thinned out by the gust band: collapse to a degenerate segment.
          pos[o + 3] = x;
          pos[o + 4] = y;
          pos[o + 5] = z;
        }
        const dy = y - cam.y;
        const dropDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const range = 1 - (dropDist - RAIN_FADE_NEAR) * RAIN_FADE_INV_SPAN;
        const fade = range > 1 ? 1 : range < 0 ? 0 : range;
        const bright = (0.72 + hash[i] * 0.5) * fade;
        const c = i * 8;
        colors[c + 3] = bright;
        colors[c + 7] = bright * 0.12;
      }
      shell.geo.setDrawRange(0, active * 2);
      (shell.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (shell.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      shell.material.opacity = shell.opacity * (0.34 + intensity * 0.66) * (1 - nightFactor * 0.32) * visible;
      shell.lines.visible = shell.material.opacity > 0.004;
    }

    // Impact feedback: seed splashes from the live drop xz of the two nearest
    // shells, so rings land where you can actually see streaks come down.
    const effectScale = this.view.renderer.getEffectScale();
    this.splashAccum += 130 * intensity * effectScale * visible * dt;
    let spawns = Math.min(14, Math.floor(this.splashAccum));
    this.splashAccum -= spawns;
    // Standing on deck, a fair spread of drops across a 13m disc puts only a
    // handful of hits on the planks — far fewer than the rain you can see
    // falling onto them. Bias a share of the budget onto the hull footprint
    // when the camera is aboard, so the deck reads as being rained on.
    const deckNode = this.getDeckShipNode();
    const deckShip = deckNode ? this.view.getTrackedShip() : null;
    const nearDeck = !!deckNode && !!deckShip
      && dist2D(cam.x, cam.z, deckNode.position.x, deckNode.position.z) < 22;
    while (spawns-- > 0) {
      if (nearDeck && deckNode && deckShip && Math.random() < 0.45) {
        const stats = SHIP_STATS[deckShip.type];
        const lx = (Math.random() * 2 - 1) * stats.width * 0.42;
        const lz = (Math.random() * 2 - 1) * stats.length * 0.40;
        const cos = Math.cos(deckNode.rotation.y);
        const sin = Math.sin(deckNode.rotation.y);
        this.spawnSplash(
          deckNode.position.x + lx * cos + lz * sin,
          deckNode.position.z + lz * cos - lx * sin,
          cam.y,
        );
        continue;
      }
      const shell = shells[Math.random() < 0.55 || shells.length === 1 ? 0 : 1];
      const o = ((Math.random() * shell.drops) | 0) * 6;
      this.spawnSplash(shell.pos[o], shell.pos[o + 2], cam.y);
    }
    this.updateSplashes(dt);

    if (this.rainHaze) {
      const haze = this.rainHaze;
      haze.position.set(cam.x, cam.y - 18, cam.z);
      haze.rotation.y = t * 0.012;
      const mat = haze.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.19 * wet * (1 - nightFactor * 0.4);
      haze.visible = mat.opacity > 0.004;
    }
  }

  updateStormLightningFlash(dt: number) {
    if (!this.stormLightningFlashEl) return;
    // Decay only — a live strike overwrites this from its envelope in
    // updateLightning, which runs later in the frame.
    this.stormLightningFlashOpacity = Math.max(0, this.stormLightningFlashOpacity - dt * 4.8);
    this.stormLightningFlashEl.style.opacity = String(this.stormLightningFlashOpacity);
  }

  // ── Lightning ─────────────────────────────────────────────────────────────
  // A strike is a branched, camera-facing RIBBON (real width, tapering down the
  // channel and across every fork) driven by a leader-flicker envelope: three
  // strobe pulses inside ~130ms, then a ~250ms afterglow. While it burns it
  // lights the sky dome and cloud deck from its own azimuth, throws a
  // directional pulse across the scene so hulls and islands flash-lit from the
  // right side, and glints the sea in a band pointing back at it.

  /** Ribbon buffers (core + wider glow) and the current strike's channel graph. */
  private bolt: {
    core: THREE.Mesh;
    glow: THREE.Mesh;
    corePos: Float32Array;
    glowPos: Float32Array;
    coreAttr: THREE.BufferAttribute;
    glowAttr: THREE.BufferAttribute;
    coreMat: THREE.MeshBasicMaterial;
    glowMat: THREE.MeshBasicMaterial;
  } | null = null;
  private readonly boltPath = new Float32Array(BOLT_MAX_NODES * 3);
  private readonly boltWidth = new Float32Array(BOLT_MAX_NODES);
  private readonly boltSegA = new Int32Array(BOLT_MAX_SEGMENTS);
  private readonly boltSegB = new Int32Array(BOLT_MAX_SEGMENTS);
  private readonly boltMainIdx = new Int32Array(BOLT_MAIN_NODES);
  private boltSegCount = 0;
  private boltAge = BOLT_LIFE;
  private boltDirX = 0;
  private boltDirZ = 1;
  /** Directional pulse: hulls and islands flash-lit from the strike's bearing.
   *  Not built on the low tier. */
  private boltLight: THREE.DirectionalLight | null = null;
  /** ?stormdemo parks a full-power storm on the camera for visual work; without
   *  this the strike gate (which keys off the REPLICATED storm ring) never fires
   *  in the demo, so the flag could not preview lightning at all. */
  private readonly stormDemo = new URLSearchParams(window.location.search).has('stormdemo');
  private readonly boltVecA = new THREE.Vector3();
  private readonly boltVecB = new THREE.Vector3();
  private readonly boltSide = new THREE.Vector3();

  /** Leader flicker: three strobe pulses inside ~130ms, then afterglow decay. */
  private boltEnvelope(age: number): number {
    if (age < 0 || age >= BOLT_LIFE) return 0;
    if (age < 0.028) return 1;
    if (age < 0.048) return 0.16;
    if (age < 0.070) return 0.80;
    if (age < 0.086) return 0.12;
    if (age < 0.118) return 0.95;
    if (age < 0.132) return 0.25;
    return 0.62 * Math.exp(-(age - 0.132) / 0.085);
  }

  /** 0..1 brightness of the strike currently burning. Probe hook. */
  debugBoltEnvelope(): number {
    return this.boltEnvelope(this.boltAge);
  }

  private makeBoltTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 4;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0.00, 'rgba(96,150,255,0.00)');
    g.addColorStop(0.30, 'rgba(150,196,255,0.50)');
    g.addColorStop(0.50, 'rgba(255,255,255,1.00)');
    g.addColorStop(0.70, 'rgba(150,196,255,0.50)');
    g.addColorStop(1.00, 'rgba(96,150,255,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 4);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private ensureBoltMeshes() {
    if (this.bolt) return this.bolt;
    const verts = BOLT_MAX_SEGMENTS * 4;
    const uv = new Float32Array(verts * 2);
    const index = new Uint16Array(BOLT_MAX_SEGMENTS * 6);
    for (let s = 0; s < BOLT_MAX_SEGMENTS; s++) {
      const v = s * 4;
      // v+0 = A-side, v+1 = A+side, v+2 = B-side, v+3 = B+side. u runs ACROSS
      // the ribbon so the texture paints a hot core with soft edges.
      uv[v * 2] = 0; uv[v * 2 + 1] = 0;
      uv[v * 2 + 2] = 1; uv[v * 2 + 3] = 0;
      uv[v * 2 + 4] = 0; uv[v * 2 + 5] = 1;
      uv[v * 2 + 6] = 1; uv[v * 2 + 7] = 1;
      const o = s * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v + 2; index[o + 4] = v + 1; index[o + 5] = v + 3;
    }
    const texture = this.makeBoltTexture();
    const build = (color: number, opacity: number) => {
      const pos = new Float32Array(verts * 3);
      const geo = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr);
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      mesh.visible = false;
      this.view.renderer.scene.add(mesh);
      return { pos, attr, mat, mesh };
    };
    const glow = build(0x6f9dff, 0.3);
    const core = build(0xffffff, 1);
    this.bolt = {
      core: core.mesh, glow: glow.mesh,
      corePos: core.pos, glowPos: glow.pos,
      coreAttr: core.attr, glowAttr: glow.attr,
      coreMat: core.mat, glowMat: glow.mat,
    };
    return this.bolt;
  }

  /** Lay out a fresh channel: a jagged main stroke from cloud base to the sea
   *  plus 2–4 forks, each thinner than the trunk it left. */
  private buildBoltChannel(lx: number, lz: number, topY: number) {
    const path = this.boltPath;
    const width = this.boltWidth;
    let n = 0;
    let bx = lx;
    let bz = lz;
    for (let i = 0; i < BOLT_MAIN_NODES; i++) {
      const f = i / (BOLT_MAIN_NODES - 1);
      path[n * 3] = bx;
      path[n * 3 + 1] = topY * (1 - f);
      path[n * 3 + 2] = bz;
      width[n] = 1.62 * (1 - f * 0.5);
      this.boltMainIdx[i] = n;
      n++;
      const jitter = 6 + f * 10;
      bx += (Math.random() - 0.5) * jitter;
      bz += (Math.random() - 0.5) * jitter;
    }
    let seg = 0;
    for (let i = 0; i + 1 < BOLT_MAIN_NODES; i++) {
      this.boltSegA[seg] = this.boltMainIdx[i];
      this.boltSegB[seg] = this.boltMainIdx[i + 1];
      seg++;
    }

    const branches = 2 + ((Math.random() * 3) | 0);
    const drop = topY / BOLT_MAIN_NODES;
    for (let b = 0; b < branches; b++) {
      if (n + 4 >= BOLT_MAX_NODES || seg + 4 >= BOLT_MAX_SEGMENTS) break;
      const parent = this.boltMainIdx[2 + ((Math.random() * (BOLT_MAIN_NODES - 6)) | 0)];
      let px = path[parent * 3];
      let py = path[parent * 3 + 1];
      let pz = path[parent * 3 + 2];
      let w = width[parent] * 0.55;
      const theta = Math.random() * Math.PI * 2;
      let dx = Math.cos(theta);
      let dz = Math.sin(theta);
      let prev = parent;
      const steps = 4 + ((Math.random() * 3) | 0);
      for (let s = 0; s < steps && n < BOLT_MAX_NODES && seg < BOLT_MAX_SEGMENTS; s++) {
        px += dx * (5 + Math.random() * 8);
        pz += dz * (5 + Math.random() * 8);
        py = Math.max(0, py - drop * (0.7 + Math.random() * 0.9));
        path[n * 3] = px;
        path[n * 3 + 1] = py;
        path[n * 3 + 2] = pz;
        w *= 0.74;
        width[n] = w;
        this.boltSegA[seg] = prev;
        this.boltSegB[seg] = n;
        seg++;
        prev = n;
        n++;
        dx += (Math.random() - 0.5) * 0.8;
        dz += (Math.random() - 0.5) * 0.8;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
      }
    }
    this.boltSegCount = seg;
  }

  /** Re-billboard the ribbon against the camera and push the vertex buffers. */
  private updateBoltRibbon(env: number) {
    const bolt = this.bolt;
    if (!bolt) return;
    const cam = this.view.renderer.camera.position;
    const path = this.boltPath;
    const width = this.boltWidth;
    // Keep the channel legible whether it strikes on top of you or on the
    // horizon: widen with distance so it never falls under a pixel.
    const midDist = Math.max(30, Math.hypot(path[0] - cam.x, path[2] - cam.z));
    const wScale = Math.min(3.0, Math.max(0.85, midDist / 380));
    const core = bolt.corePos;
    const glow = bolt.glowPos;
    for (let s = 0; s < this.boltSegCount; s++) {
      const a = this.boltSegA[s] * 3;
      const b = this.boltSegB[s] * 3;
      this.boltVecA.set(path[b] - path[a], path[b + 1] - path[a + 1], path[b + 2] - path[a + 2]);
      this.boltVecB.set(
        (path[a] + path[b]) * 0.5 - cam.x,
        (path[a + 1] + path[b + 1]) * 0.5 - cam.y,
        (path[a + 2] + path[b + 2]) * 0.5 - cam.z,
      );
      this.boltSide.crossVectors(this.boltVecA, this.boltVecB);
      if (this.boltSide.lengthSq() < 1e-8) this.boltSide.set(1, 0, 0);
      else this.boltSide.normalize();
      const wa = width[this.boltSegA[s]] * wScale;
      const wb = width[this.boltSegB[s]] * wScale;
      const v = s * 12;
      for (let pass = 0; pass < 2; pass++) {
        const buf = pass === 0 ? core : glow;
        const ka = pass === 0 ? wa : wa * 3.8;
        const kb = pass === 0 ? wb : wb * 3.8;
        buf[v] = path[a] - this.boltSide.x * ka;
        buf[v + 1] = path[a + 1] - this.boltSide.y * ka;
        buf[v + 2] = path[a + 2] - this.boltSide.z * ka;
        buf[v + 3] = path[a] + this.boltSide.x * ka;
        buf[v + 4] = path[a + 1] + this.boltSide.y * ka;
        buf[v + 5] = path[a + 2] + this.boltSide.z * ka;
        buf[v + 6] = path[b] - this.boltSide.x * kb;
        buf[v + 7] = path[b + 1] - this.boltSide.y * kb;
        buf[v + 8] = path[b + 2] - this.boltSide.z * kb;
        buf[v + 9] = path[b] + this.boltSide.x * kb;
        buf[v + 10] = path[b + 1] + this.boltSide.y * kb;
        buf[v + 11] = path[b + 2] + this.boltSide.z * kb;
      }
    }
    bolt.core.geometry.setDrawRange(0, this.boltSegCount * 6);
    bolt.glow.geometry.setDrawRange(0, this.boltSegCount * 6);
    bolt.coreAttr.needsUpdate = true;
    bolt.glowAttr.needsUpdate = true;
    bolt.coreMat.opacity = env;
    bolt.glowMat.opacity = env * 0.42;
    bolt.core.visible = true;
    bolt.glow.visible = true;
  }

  updateLightning(dt: number) {
    if (!this.view.state) return;

    // ── Play out the strike that is burning ────────────────────────────────
    if (this.boltAge < BOLT_LIFE) {
      this.boltAge += dt;
      const env = this.boltEnvelope(this.boltAge);
      this.updateBoltRibbon(env);
      if (this.lightningFlash) this.lightningFlash.intensity = env * (42 + this.view.state.storm.phase * 8);
      if (this.boltLight) this.boltLight.intensity = env * 2.3;
      this.view.renderer.setLightningFlash(env * 0.95, this.boltDirX, this.boltDirZ);
      this.view.ocean.setLightningFlash(env, this.boltDirX, this.boltDirZ);
      if (this.stormLightningFlashEl) {
        const peak = 0.20 + this.view.stormWeatherIntensity * 0.28 + this.view.state.storm.phase * 0.015;
        this.stormLightningFlashOpacity = Math.max(this.stormLightningFlashOpacity, env * peak);
        this.stormLightningFlashEl.style.opacity = String(this.stormLightningFlashOpacity);
      }
      if (this.boltAge >= BOLT_LIFE) {
        if (this.bolt) {
          this.bolt.core.visible = false;
          this.bolt.glow.visible = false;
        }
        if (this.lightningFlash) this.lightningFlash.intensity = 0;
        if (this.boltLight) this.boltLight.intensity = 0;
        this.view.renderer.setLightningFlash(0, this.boltDirX, this.boltDirZ);
        this.view.ocean.setLightningFlash(0, this.boltDirX, this.boltDirZ);
      }
    }
    // Keep the directional pulse aimed from the strike's bearing at the camera.
    if (this.boltLight && this.boltLight.intensity > 0) {
      const cam = this.view.renderer.camera.position;
      this.boltLight.target.position.copy(cam);
      this.boltLight.position.set(cam.x + this.boltDirX * 180, cam.y + 130, cam.z + this.boltDirZ * 180);
    }

    const phase = this.view.state.storm.phase;
    const player = this.view.getLocalPlayer();
    const playerDist = player
      ? dist2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ)
      : 0;
    const outsideStorm = !!player
      && playerDist > this.view.state.storm.safeRadius;
    const nearStormWall = !!player && Math.abs(playerDist - this.view.state.storm.safeRadius) < 85;

    // Keep lightning tied to the storm front, not clear water well inside the safe zone.
    if (!this.stormDemo && !outsideStorm && !(this.view.state.storm.shrinking && nearStormWall) && phase < 2) return;

    this.lightningTimer -= dt;
    if (this.lightningTimer <= 0) {
      const stormR = this.view.state.storm.safeRadius;
      const angle = Math.random() * Math.PI * 2;
      let lx: number;
      let lz: number;
      if (this.stormDemo) {
        // Demo storm is parked on the camera: strike where it can be seen.
        const camPos = this.view.renderer.camera.position;
        const demoDist = 190 + Math.random() * 260;
        lx = camPos.x + Math.cos(angle) * demoDist;
        lz = camPos.z + Math.sin(angle) * demoDist;
      } else {
        // Strike near the storm wall boundary
        const dist = stormR * (0.88 + Math.random() * 0.38);
        lx = this.view.state.storm.centerX + Math.cos(angle) * dist;
        lz = this.view.state.storm.centerZ + Math.sin(angle) * dist;
      }

      // Pooled flash light (allocating one per strike forced shader churn).
      // A 300m-radius point light re-lights every fragment of every island,
      // hull and wave in reach for the length of the strike; on the bottom tier
      // the sky flash, the bolt ribbon and the screen pulse carry the moment on
      // their own, so the world-lighting pass is the part that gets dropped.
      if (this.view.renderer.getQuality() !== 'low') {
        if (!this.lightningLightPool) {
          this.lightningLightPool = new THREE.PointLight(0x9fc4e6, 0, 300);
          registerBudgetLight(this.lightningLightPool);
          this.view.renderer.scene.add(this.lightningLightPool);
        }
        const flash = this.lightningLightPool;
        flash.intensity = 42 + phase * 8;
        flash.distance = Math.max(300, stormR * 0.9);
        flash.position.set(lx, 85 + Math.random() * 50, lz);
        this.lightningFlash = flash;
      }

      // Branched ribbon channel: cloud base down to the sea.
      this.ensureBoltMeshes();
      this.buildBoltChannel(lx, lz, 150 + Math.random() * 46);
      this.boltAge = 0;
      const cam = this.view.renderer.camera.position;
      const bdx = lx - cam.x;
      const bdz = lz - cam.z;
      const blen = Math.hypot(bdx, bdz) || 1;
      this.boltDirX = bdx / blen;
      this.boltDirZ = bdz / blen;
      // Thunder boom matched to the actual strike distance.
      const localPlayerForThunder = this.view.getLocalPlayer();
      if (localPlayerForThunder) {
        this.view.audio.playThunder(dist2D(localPlayerForThunder.position.x, localPlayerForThunder.position.z, lx, lz));
      }

      const baseCooldown = this.stormDemo
        ? 1.6 // demo preview: strike often enough to actually look at
        : Math.max(
          0.75,
          10.5 - phase * 1.25 - (outsideStorm ? 3.2 : 0) - this.view.stormWeatherIntensity * 2.5,
        );
      this.lightningTimer = baseCooldown * (0.35 + Math.random() * 0.85);
    }
  }
}
