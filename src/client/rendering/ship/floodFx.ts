// Flood jets and boil (b2.3b, holes-08). Every open breach the SHARED flood
// model says is taking water gets, on the client:
//  - above the hold water: one continuous tapered ribbon of water on its
//    Torricelli arc (exit speed sqrt(2 g h) from the net head, the same number
//    the server floods with), a particle stream along it and a splash where it
//    lands on the sole or the hold water;
//  - under the hold water: a bubble plume and a foam boil on the hold surface
//    (setHoldWaterFoam), no jet: the sea is now pushing into water, not air.
// All ribbons of all ships are ONE instanced draw. A patched (or drying) hole
// releases over FLOOD_JET_RELEASE_S; a foundering hull keeps its jets through
// the first FLOOD_JET_FOUNDER_F of the founder. getFloodEmitters() hands the
// audio lane (audio-02) the live per-hole state.
//
// The flooding predicate is NOT re-derived here: holeFloodState() places the
// hole exactly as FloodSystem.evaluateHoleFlood does and calls the shared
// holeIngress / holeInsideHead, so the client can never draw a dry breach that
// floods on the server (the retired +0.2 m client margin did, for 0.2-0.3 m).
import * as THREE from 'three';
import type { ShipHole, ShipType } from '../../../shared/types/index.js';
import { FLOODING } from '../../../shared/constants/index.js';
import {
  GRAVITY, holeHeadFactor, holeIngress, holeInsideHead, holeNetHead, holeSizeArea, holeVisualRadius,
} from '../../../shared/flooding/floodModel.js';
import { fillToLocalY, getHullVolumeTable } from '../../../shared/flooding/hullVolume.js';
import { setHoldWaterFoam, type HoldWaterHandle } from './holdWater.js';

// ── Pure model (graded by scripts/test-flood-fx-model.mjs) ──────────────────

/** Seconds a jet takes to die after its hole is patched or goes dry. */
export const FLOOD_JET_RELEASE_S = 0.3;
/** Jets keep running through this fraction of SHIP.SINK_TIME of the founder. */
export const FLOOD_JET_FOUNDER_F = 0.6;
/** Most jets drawn at once (all ships): the ribbon instance count. */
export const FLOOD_JET_MAX = 24;

export interface FloodShipPose {
  type: ShipType;
  position: { x: number; y: number; z: number };
  rotation: number;
  pitch?: number;
  roll?: number;
  waterLevel?: number;
}

export type FloodHoleMode = 'none' | 'jet' | 'boil';

export interface HoleFloodFxState {
  /** Metres under the outside surface (negative = above it). */
  depth: number;
  insideHead: number;
  netHead: number;
  /** The server's predicate: holeIngress > 0. */
  flooding: boolean;
  /** Fill fraction per second through this hole (the shared law). */
  q: number;
  /** Exit speed (m/s): sqrt(2 g h) of the net head, the wash weep below 0. */
  v: number;
  /** The hold water stands over the hole centre. */
  submergedInside: boolean;
  mode: FloodHoleMode;
}

/** Torricelli: v = sqrt(2 g h), h capped at FLOODING.MAX_HEAD, 0 when dry. */
export function jetExitSpeed(head: number): number {
  if (!(head > 0)) return 0;
  return Math.sqrt(2 * GRAVITY * Math.min(FLOODING.MAX_HEAD, head));
}

/** A hole's world point on the SERVER's pose model (FloodSystem.evaluateHoleFlood). */
export function holeWorldPoint(ship: FloodShipPose, hole: Pick<ShipHole, 'x' | 'y' | 'z'>): { x: number; y: number; z: number } {
  const sinR = Math.sin(ship.rotation);
  const cosR = Math.cos(ship.rotation);
  return {
    x: ship.position.x + hole.x * cosR + hole.z * sinR,
    z: ship.position.z + hole.z * cosR - hole.x * sinR,
    y: ship.position.y + hole.y + hole.x * Math.sin(ship.roll ?? 0) - hole.z * Math.sin(ship.pitch ?? 0),
  };
}

/** The per-hole flood state for FX, from the outside surface height at the hole. */
export function holeFloodState(
  ship: FloodShipPose, hole: Pick<ShipHole, 'x' | 'y' | 'z' | 'size'>, surfaceY: number,
): HoleFloodFxState {
  const fill = Math.min(1, Math.max(0, ship.waterLevel ?? 0));
  const depth = surfaceY - holeWorldPoint(ship, hole).y;
  const insideHead = holeInsideHead(ship.type, fill, hole.y);
  const netHead = holeNetHead(depth, insideHead);
  const q = holeIngress(ship.type, holeSizeArea(hole.size), depth, insideHead);
  const flooding = q > 0;
  const v = !flooding ? 0 : netHead > 0 ? jetExitSpeed(netHead) : holeHeadFactor(netHead);
  const submergedInside = fill > 0 && fillToLocalY(ship.type, fill) > hole.y;
  return { depth, insideHead, netHead, flooding, q, v, submergedInside, mode: !flooding ? 'none' : submergedInside ? 'boil' : 'jet' };
}

/**
 * Time of flight of a jet leaving at horizontal speed `vh` and vertical `vy`
 * until it has dropped `drop` metres, cut short when its horizontal reach hits
 * `maxReach` (the far side of the hold).
 */
export function jetFlightTime(vh: number, vy: number, drop: number, maxReach: number): number {
  const d = Math.max(0, drop);
  const t = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * d)) / GRAVITY;
  if (vh > 1e-6 && vh * t > maxReach) return Math.max(0, maxReach) / vh;
  return t;
}

/** Jet strength `since` seconds after its hole closed (1 -> 0 over 300 ms). */
export function jetReleaseStrength(since: number): number {
  return Math.min(1, Math.max(0, 1 - since / FLOOD_JET_RELEASE_S));
}

/** Are this hull's jets still running (not sinking, or early in the founder)? */
export function founderJetsOpen(ship: { sinking?: boolean; sinkProgress?: number }): boolean {
  return !ship.sinking || (ship.sinkProgress ?? 0) < FLOOD_JET_FOUNDER_F;
}

// ── Live FX ─────────────────────────────────────────────────────────────────

/** Per-hole state the audio lane reads (audio-02). World space. */
export interface FloodEmitter {
  holeId: number;
  worldPos: { x: number; y: number; z: number };
  /** Outward hull normal at the breach. */
  normal: { x: number; y: number; z: number };
  /** Fill fraction per second through the hole. */
  q: number;
  /** Exit speed m/s (0 while releasing after a patch). */
  v: number;
  submergedInside: boolean;
  /** 0..1, fades over FLOOD_JET_RELEASE_S after a patch. */
  strength: number;
}

/** What the FX need from the particle system (CombatFx implements it). */
export interface FloodParticleSink {
  emitFloodSpray(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number): void;
  emitFloodSplash(x: number, y: number, z: number, strength: number): void;
  emitFloodBubbles(x: number, y: number, z: number, strength: number): void;
}

export interface FloodFxShip extends FloodShipPose {
  id: string;
  holes?: ShipHole[];
  sinking?: boolean;
  sinkProgress?: number;
}

export interface FloodFxSources {
  anchors(shipId: string): Array<{ id: number; anchor: THREE.Object3D; active: boolean }>;
  holdWater(shipId: string): HoldWaterHandle | null;
  surfaceY(x: number, z: number): number;
}

interface JetTrack {
  holeId: number;
  emitter: FloodEmitter;
  /** Seconds since the hole stopped flooding (-1 = open). */
  closedFor: number;
  onset: number;
  mode: FloodHoleMode;
  origin: THREE.Vector3;
  vel: THREE.Vector3;
  flight: number;
  width: number;
  landY: number;
  landsOnWater: boolean;
  landLocal: { x: number; z: number };
  boilLocal: { x: number; z: number };
  surfaceWorldY: number;
  sprayAcc: number;
  splashAcc: number;
  seed: number;
  seen: boolean;
}

const SEGMENTS = 16;
const tmpPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

function makeRibbonGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((SEGMENTS + 1) * 2 * 3);
  const idx: number[] = [];
  for (let i = 0; i <= SEGMENTS; i += 1) {
    const u = i / SEGMENTS;
    pos.set([u, -1, 0, u, 1, 0], i * 6);
    if (i < SEGMENTS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.setAttribute('iOrigin', new THREE.InstancedBufferAttribute(new Float32Array(FLOOD_JET_MAX * 3), 3));
  g.setAttribute('iVel', new THREE.InstancedBufferAttribute(new Float32Array(FLOOD_JET_MAX * 3), 3));
  // flight time, root width, alpha, seed
  g.setAttribute('iParams', new THREE.InstancedBufferAttribute(new Float32Array(FLOOD_JET_MAX * 4), 4));
  g.instanceCount = 0;
  return g;
}

const RIBBON_VERT = /* glsl */ `
attribute vec3 iOrigin;
attribute vec3 iVel;
attribute vec4 iParams;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
void main() {
  float u = position.x;
  float tt = u * iParams.x;
  vec3 p = iOrigin + iVel * tt + vec3(0.0, -0.5 * ${GRAVITY.toFixed(2)} * tt * tt, 0.0);
  vec3 tang = normalize(iVel + vec3(0.0, -${GRAVITY.toFixed(2)} * tt, 0.0) + vec3(1e-4));
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = cross(tang, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  // Tapered: the stream necks as gravity speeds it up, then frays at the end.
  float w = iParams.y * mix(1.0, 0.55, smoothstep(0.0, 0.7, u)) * (1.0 + 0.9 * smoothstep(0.75, 1.0, u));
  p += side * w * position.y;
  vUv = vec2(u, position.y);
  vAlpha = iParams.z;
  vSeed = iParams.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const RIBBON_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uFoam;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
float h1(float n) { return fract(sin(n) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  float across = abs(vUv.y);
  // Streaks that travel down the jet at the water's speed.
  float flow = vUv.x * 9.0 - uTime * 6.0 + vSeed * 17.0;
  float streak = n1(flow + vUv.y * 3.1) * 0.6 + n1(flow * 2.3 - vUv.y * 5.7) * 0.4;
  float core = 1.0 - smoothstep(0.35 + 0.35 * streak, 1.0, across);
  // The end frays into spray.
  float fray = 1.0 - smoothstep(0.7, 1.0, vUv.x) * (0.55 + 0.45 * streak);
  float a = vAlpha * core * fray * (0.55 + 0.45 * streak);
  if (a < 0.02) discard;
  float white = clamp(0.35 + 0.5 * streak * (1.0 - across) + 0.4 * smoothstep(0.6, 1.0, vUv.x), 0.0, 1.0);
  gl_FragColor = vec4(mix(uColor, uFoam, white), a);
}`;

export class FloodFx {
  private readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tracks = new Map<string, Map<number, JetTrack>>();
  private readonly foamShips = new Set<string>();
  private seedN = 0;

  constructor(parent: THREE.Object3D, private readonly particles: FloodParticleSink) {
    this.geo = makeRibbonGeometry();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x7fb4c0) },
        uFoam: { value: new THREE.Color(0xeaf6fa) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'flood-jets';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Live per-hole state for the audio lane (empty when the ship is dry). */
  getFloodEmitters(shipId: string): FloodEmitter[] {
    const m = this.tracks.get(shipId);
    if (!m) return [];
    const out: FloodEmitter[] = [];
    for (const tr of m.values()) out.push(tr.emitter);
    return out;
  }

  /** Still drawing (or releasing) anything for this hull? Keep feeding it
   *  after its last hole is patched so the 300 ms release plays out. */
  tracking(shipId: string): boolean { return this.tracks.has(shipId); }

  /** Jets drawn last frame (probes and gates). */
  get jetCount(): number { return this.geo.instanceCount; }

  update(dt: number, t: number, ships: Iterable<FloodFxShip>, src: FloodFxSources): void {
    this.mat.uniforms.uTime.value = t;
    const live = new Set<string>();
    for (const ship of ships) {
      live.add(ship.id);
      this.updateShip(dt, ship, src);
    }
    for (const id of [...this.tracks.keys()]) {
      if (!live.has(id)) this.dropShip(id, src);
    }
    this.writeInstances();
  }

  private dropShip(id: string, src: FloodFxSources): void {
    this.tracks.delete(id);
    if (this.foamShips.delete(id)) {
      const hw = src.holdWater(id);
      if (hw) setHoldWaterFoam(hw, []);
    }
  }

  private updateShip(dt: number, ship: FloodFxShip, src: FloodFxSources): void {
    let map = this.tracks.get(ship.id);
    const open = founderJetsOpen(ship);
    const holesById = new Map<number, ShipHole>();
    for (const h of ship.holes ?? []) if (!h.patched) holesById.set(h.id, h);
    const vt = getHullVolumeTable(ship.type);
    const fill = Math.min(1, Math.max(0, ship.waterLevel ?? 0));
    const insideY = fill > 0 ? fillToLocalY(ship.type, fill) : vt.soleY;
    const cosR = Math.cos(ship.rotation);
    const sinR = Math.sin(ship.rotation);
    const toLocal = (wx: number, wz: number) => {
      const dx = wx - ship.position.x;
      const dz = wz - ship.position.z;
      return { x: dx * cosR - dz * sinR, z: dx * sinR + dz * cosR };
    };

    if (map) for (const tr of map.values()) tr.seen = false;
    for (const a of src.anchors(ship.id)) {
      const hole = a.active ? holesById.get(a.id) : undefined;
      let state: HoleFloodFxState | null = null;
      if (hole && open) {
        const p = holeWorldPoint(ship, hole);
        state = holeFloodState(ship, hole, src.surfaceY(p.x, p.z));
        if (!state.flooding) state = null;
      }
      let tr = map?.get(a.id);
      if (tr) tr.seen = true;
      if (!state) {
        if (tr) tr.closedFor = tr.closedFor < 0 ? 0 : tr.closedFor;
        continue;
      }
      if (!map) { map = new Map(); this.tracks.set(ship.id, map); }
      if (!tr) {
        tr = {
          holeId: a.id, closedFor: -1, onset: 0, mode: state.mode,
          emitter: { holeId: a.id, worldPos: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, q: 0, v: 0, submergedInside: false, strength: 0 },
          origin: new THREE.Vector3(), vel: new THREE.Vector3(), flight: 0, width: 0, landY: 0,
          landsOnWater: false, landLocal: { x: 0, z: 0 }, boilLocal: { x: 0, z: 0 }, surfaceWorldY: 0,
          sprayAcc: 0, splashAcc: 0, seed: (this.seedN++ % 97) + 0.37, seen: true,
        };
        map.set(a.id, tr);
      }
      tr.closedFor = -1;
      tr.mode = state.mode;
      const hr = holeVisualRadius(hole!.size);
      // The anchor rides the DRAWN hull 0.12 m outboard along +Z = outward normal.
      a.anchor.getWorldPosition(tmpPos);
      a.anchor.getWorldDirection(tmpDir);
      const e = tr.emitter;
      e.worldPos.x = tmpPos.x; e.worldPos.y = tmpPos.y; e.worldPos.z = tmpPos.z;
      e.normal.x = tmpDir.x; e.normal.y = tmpDir.y; e.normal.z = tmpDir.z;
      e.q = state.q; e.v = state.v; e.submergedInside = state.submergedInside;
      // Inner face of the breach: 0.12 out + the plank = ~0.2 m back along -normal.
      tr.origin.copy(tmpPos).addScaledVector(tmpDir, -0.2);
      tr.vel.copy(tmpDir).multiplyScalar(-state.v);
      tr.vel.y += 0.08 * state.v; // the jet lips over the torn lower edge
      tr.width = hr * (0.55 + 0.45 * Math.min(1, state.v / 3));
      const landLocalY = Math.max(vt.soleY, insideY);
      const drop = Math.max(0.05, hole!.y - landLocalY);
      tr.landsOnWater = fill > 0.01;
      const vh = Math.hypot(tr.vel.x, tr.vel.z);
      tr.flight = jetFlightTime(vh, tr.vel.y, drop, Math.max(0.4, 1.8 * Math.abs(hole!.x)));
      tr.landY = tr.origin.y - drop;
      const lx = tr.origin.x + tr.vel.x * tr.flight;
      const lz = tr.origin.z + tr.vel.z * tr.flight;
      tr.landLocal = toLocal(lx, lz);
      tr.boilLocal = toLocal(tr.origin.x, tr.origin.z);
      tr.surfaceWorldY = tr.origin.y + (insideY - hole!.y);
    }

    if (!map) return;
    // A breach whose anchor vanished (hull rebuilt, hole retired) releases too.
    for (const tr of map.values()) if (!tr.seen && tr.closedFor < 0) tr.closedFor = 0;
    const rings: Array<{ x: number; z: number; radius: number; strength: number }> = [];
    for (const [id, tr] of map) {
      if (tr.closedFor >= 0) tr.closedFor += dt;
      tr.onset = Math.min(1, tr.onset + dt / 0.15);
      const s = (tr.closedFor < 0 ? 1 : jetReleaseStrength(tr.closedFor)) * tr.onset;
      tr.emitter.strength = s;
      if (tr.closedFor >= 0) tr.emitter.v = 0;
      if (s <= 0) { map.delete(id); continue; }
      const vNorm = Math.min(1, tr.emitter.v / 4.4 + 0.25);
      if (tr.mode === 'boil') {
        rings.push({ x: tr.boilLocal.x, z: tr.boilLocal.z, radius: 0.25 + 0.45 * vNorm, strength: s * vNorm });
        tr.splashAcc += dt * 14 * s * vNorm;
        while (tr.splashAcc >= 1) {
          tr.splashAcc -= 1;
          this.particles.emitFloodBubbles(
            tr.origin.x + (Math.random() - 0.5) * 0.3, tr.surfaceWorldY, tr.origin.z + (Math.random() - 0.5) * 0.3, s * vNorm,
          );
        }
        continue;
      }
      // Jet: stream particles along the arc, splash where it lands.
      tr.sprayAcc += dt * 26 * s * vNorm;
      while (tr.sprayAcc >= 1) {
        tr.sprayAcc -= 1;
        const jitter = 0.12 * tr.emitter.v;
        this.particles.emitFloodSpray(
          tr.origin.x, tr.origin.y, tr.origin.z,
          tr.vel.x + (Math.random() - 0.5) * jitter, tr.vel.y + (Math.random() - 0.5) * jitter, tr.vel.z + (Math.random() - 0.5) * jitter,
          tr.width * 0.5,
        );
      }
      tr.splashAcc += dt * 7 * s;
      const lx = tr.origin.x + tr.vel.x * tr.flight;
      const lz = tr.origin.z + tr.vel.z * tr.flight;
      while (tr.splashAcc >= 1) {
        tr.splashAcc -= 1;
        this.particles.emitFloodSplash(lx, tr.landY + 0.02, lz, s * vNorm);
      }
      if (tr.landsOnWater) rings.push({ x: tr.landLocal.x, z: tr.landLocal.z, radius: 0.2 + 0.35 * vNorm, strength: 0.8 * s * vNorm });
    }
    if (map.size === 0) this.tracks.delete(ship.id);

    const hw = src.holdWater(ship.id);
    if (hw) {
      if (rings.length) {
        rings.sort((p, q) => q.strength - p.strength);
        setHoldWaterFoam(hw, rings.slice(0, 4));
        this.foamShips.add(ship.id);
      } else if (this.foamShips.delete(ship.id)) {
        setHoldWaterFoam(hw, []);
      }
    }
  }

  private writeInstances(): void {
    const o = this.geo.getAttribute('iOrigin') as THREE.InstancedBufferAttribute;
    const v = this.geo.getAttribute('iVel') as THREE.InstancedBufferAttribute;
    const p = this.geo.getAttribute('iParams') as THREE.InstancedBufferAttribute;
    let n = 0;
    for (const map of this.tracks.values()) {
      for (const tr of map.values()) {
        if (n >= FLOOD_JET_MAX) break;
        if (tr.mode !== 'jet' || tr.emitter.strength <= 0) continue;
        o.setXYZ(n, tr.origin.x, tr.origin.y, tr.origin.z);
        v.setXYZ(n, tr.vel.x, tr.vel.y, tr.vel.z);
        p.setXYZW(n, tr.flight, tr.width, 0.85 * tr.emitter.strength, tr.seed);
        n += 1;
      }
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) { o.needsUpdate = true; v.needsUpdate = true; p.needsUpdate = true; }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.tracks.clear();
  }
}
