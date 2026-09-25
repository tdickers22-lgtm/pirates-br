// Founder FX (b2.3g, holes-09 + vm:physics:3). The server founders a hull in
// three stages over SHIP.SINK_TIME (FloodSystem.stepShipFounder: settle, trim,
// plunge). The client used to add nothing: the waterline foam and the wake
// switched off and she slid under. Keyed off ship.sinking + sinkProgress, this
// adds, per foundering hull within FOUNDER_FX_RANGE of the camera:
//  - HATCH AIR-BURST (sinkProgress 0.1-0.3): the air the rising water drives
//    out of her comes up the companionway and the hold grating as two spray
//    columns (CombatFx's droplet pool, no new pool);
//  - DEBRIS: barrels, crates and planks seeded by ship id (client-only, the
//    same wreck on every client), half blown up the hatches during the burst,
//    the rest shed along the deck at the plunge. They float on the LIVE Gerstner
//    field (the renderer's getSurfaceY, the same surface the sea draws), bob on
//    a damped buoyancy spring, tilt with the local slope, drift downwind at a
//    few percent of the wind and are pulled round the plunge vortex, then
//    waterlog and go under at DEBRIS_LIFE_S (30 s);
//  - PLUNGE: a bubble column breaking the surface over where she went down for
//    BUBBLE_COLUMN_S (6 s) and a swirling foam ring (the vortex) spreading from
//    the same point.
// The hold water keeps drawing at fill 1 the whole founder (ShipRenderer feeds
// fill = 1 while sinking), so it reads through the hatches throughout.
// Draw cost: 0 when no founder is live; with debris afloat, 2 instanced draws
// (barrels, boxes) + 1 per live vortex ring (at most FOUNDER_RING_MAX). No lights.
import * as THREE from 'three';
import type { ShipType } from '../../../shared/types/index.js';
import { SHIP_STATS } from '../../../shared/constants/index.js';
import { getShipCompanionwayConfig } from '../../../shared/utils/index.js';
import type { FloodParticleSink } from './floodFx.js';

// ── Pure model (graded by scripts/probes/founder-probe.mjs) ─────────────────

/** Hatch air-burst window, in sinkProgress. */
export const FOUNDER_BURST_F: readonly [number, number] = [0.1, 0.3];
/** The plunge begins here. Mirrors FloodSystem FOUNDER.PLUNGE_F (server-only module). */
export const FOUNDER_PLUNGE_F = 0.7;
/** Seconds a piece of wreckage stays afloat. */
export const DEBRIS_LIFE_S = 30;
/** Seconds of the last DEBRIS_LIFE_S over which it waterlogs and goes under. */
export const DEBRIS_SINK_OUT_S = 3;
/** Seconds the bubble column boils over the plunge. */
export const BUBBLE_COLUMN_S = 6;
/** Seconds the vortex foam ring lives (it outlasts the column a little). */
export const VORTEX_RING_S = 7.5;
export const FOUNDER_FX_RANGE = 160;
export const FOUNDER_DEBRIS_MAX = 72;
export const FOUNDER_RING_MAX = 2;

export type DebrisKind = 'barrel' | 'crate' | 'plank';

export interface DebrisSeed {
  kind: DebrisKind;
  /** Released with the hatch burst (up a hatch) or shed at the plunge (along the deck). */
  stage: 'burst' | 'plunge';
  /** Release point in sinkProgress. */
  at: number;
  /** Hull-local spawn offset (x beam, z along the keel), y on deck. */
  lx: number;
  lz: number;
  /** Launch velocity, hull-local (m/s). */
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  spin: number;
  /** 0.85..1.15 size jitter. */
  scale: number;
  /** 0..1 wood-tone jitter. */
  tone: number;
}

/** FNV-1a of the ship id: the wreck is the same on every client. */
export function founderSeed(shipId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < shipId.length; i += 1) {
    h ^= shipId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hatchCache = new Map<ShipType, HatchPoint[]>();

export interface HatchPoint { x: number; y: number; z: number; halfX: number; halfZ: number }

/** The two openings the air comes out of, hull-local: the companionway and the
 *  hold grating (the same numbers ShipRenderer builds them from). */
export function founderHatches(type: ShipType): HatchPoint[] {
  const hit = hatchCache.get(type);
  if (hit) return hit;
  const stats = SHIP_STATS[type];
  const W = stats.width;
  const L = stats.length;
  const H = stats.height;
  const c = getShipCompanionwayConfig(stats);
  const grateW = Math.min(W * 0.34, 1.4);
  const grateL = Math.min(L * 0.16, 1.5);
  const out = [
    { x: c.cx, y: H + 0.1, z: c.cz, halfX: c.halfX, halfZ: c.halfZ },
    { x: W * 0.2, y: H + 0.13, z: c.cz + c.halfZ + grateL * 0.65 + 0.22, halfX: grateW * 0.5, halfZ: grateL * 0.5 },
  ];
  hatchCache.set(type, out);
  return out;
}

/** Seeded wreck for one hull: 8 / 12 / 16 pieces by class, ~half up the hatches. */
export function founderDebrisPlan(shipId: string, type: ShipType): DebrisSeed[] {
  const rnd = mulberry32(founderSeed(shipId));
  const stats = SHIP_STATS[type];
  const count = type === 'sloop' ? 8 : type === 'brigantine' ? 12 : 16;
  const hatches = founderHatches(type);
  const out: DebrisSeed[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = rnd();
    const kind: DebrisKind = r < 0.36 ? 'barrel' : r < 0.66 ? 'crate' : 'plank';
    const burst = i % 2 === 0;
    let lx: number;
    let lz: number;
    let vy: number;
    if (burst) {
      const h = hatches[i % 4 === 0 ? 0 : 1];
      lx = h.x + (rnd() * 2 - 1) * h.halfX * 0.8;
      lz = h.z + (rnd() * 2 - 1) * h.halfZ * 0.8;
      vy = 3.5 + rnd() * 3;
    } else {
      lx = (rnd() * 2 - 1) * stats.width * 0.38;
      lz = (rnd() * 2 - 1) * stats.length * 0.4;
      vy = 0.6 + rnd() * 1.2;
    }
    const out01 = rnd() * 2 - 1;
    out.push({
      kind,
      stage: burst ? 'burst' : 'plunge',
      at: burst
        ? FOUNDER_BURST_F[0] + 0.02 + rnd() * (FOUNDER_BURST_F[1] - FOUNDER_BURST_F[0] - 0.04)
        : FOUNDER_PLUNGE_F + rnd() * 0.18,
      lx, lz,
      vx: out01 * (burst ? 2.2 : 1.2) + Math.sign(lx || out01) * 0.6,
      vy,
      vz: (rnd() * 2 - 1) * (burst ? 1.4 : 0.8),
      yaw: rnd() * Math.PI * 2,
      spin: (rnd() * 2 - 1) * 0.5,
      scale: 0.85 + rnd() * 0.3,
      tone: rnd(),
    });
  }
  return out;
}

/** Fraction of a piece below its own centre when floating at rest (m). */
export function debrisDraft(kind: DebrisKind, scale: number): number {
  return (kind === 'barrel' ? 0.06 : kind === 'crate' ? 0.08 : 0.0) * scale;
}

export interface FloatingBody {
  kind: DebrisKind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; spin: number;
  scale: number;
  tone: number;
  age: number;
  /** Surface slope (dh/dx, dh/dz) at the body, for the tilt. */
  sx: number; sz: number;
  /** Washed up on an island (resting on the terrain, not the sea). */
  stranded: boolean;
}

export interface FloatEnv {
  /** World surface height (live Gerstner field). */
  surfaceY(x: number, z: number): number;
  /** Wind velocity the water surface feels (m/s, world x/z). */
  windX: number;
  windZ: number;
  /** Island terrain height, -Infinity over open sea (optional). */
  groundY?(x: number, z: number): number;
  /** Plunge vortex centre + strength 0..1 (0 = none). */
  vortex?: { x: number; z: number; strength: number; radius: number } | null;
}

/** Windage: a floating box/barrel drifts at ~3.5% of the wind. */
export const DEBRIS_WINDAGE = 0.035;
const BUOY_K = 26;
// Near-critical (2 sqrt(k) = 10.2): a piece surfacing from under the plunge
// comes up and settles on the swell instead of leaping clear of it.
const WATER_DAMP = 8.5;
/** Contact band over the rest height: still wet, still damped. */
const WET_BAND = 0.25;
const H_DRAG = 0.9;
const SLOPE_PUSH = 2.4;

/** One step of one floating piece: buoyancy spring toward the live surface,
 *  gravity when airborne, horizontal drag toward the wind drift plus the
 *  wave-slope push and the vortex swirl, spin decaying on the water, and the
 *  waterlogged sink-out in the last DEBRIS_SINK_OUT_S. */
export function stepFloatingBody(b: FloatingBody, dt: number, env: FloatEnv): void {
  b.age += dt;
  const e = 0.35;
  const h = env.surfaceY(b.x, b.z);
  b.sx = (env.surfaceY(b.x + e, b.z) - h) / e;
  b.sz = (env.surfaceY(b.x, b.z + e) - h) / e;
  const sinkOut = Math.max(0, (b.age - (DEBRIS_LIFE_S - DEBRIS_SINK_OUT_S)) / DEBRIS_SINK_OUT_S);
  const floatRest = h - debrisDraft(b.kind, b.scale) - sinkOut * 1.2;
  const ground = env.groundY ? env.groundY(b.x, b.z) : -Infinity;
  // Washed into the shallows: she rests on the sand and stops drifting.
  const groundRest = ground + (b.kind === 'plank' ? 0.04 : 0.24) * b.scale;
  b.stranded = groundRest > floatRest;
  const rest = b.stranded ? groundRest : floatRest;
  const inWater = b.y <= rest + WET_BAND;
  if (inWater && b.stranded) {
    if (b.y < rest) { b.y = rest; b.vy = Math.max(0, b.vy); }
    const a = 1 - Math.exp(-5 * dt);
    b.vx -= b.vx * a;
    b.vz -= b.vz * a;
    b.spin -= b.spin * a;
    b.sx = 0;
    b.sz = 0;
  } else if (inWater) {
    b.vy += (rest - b.y) * BUOY_K * dt;
    b.vy *= Math.exp(-WATER_DAMP * dt);
    b.spin *= Math.exp(-0.6 * dt);
    let tx = env.windX * DEBRIS_WINDAGE - b.sx * SLOPE_PUSH;
    let tz = env.windZ * DEBRIS_WINDAGE - b.sz * SLOPE_PUSH;
    const v = env.vortex;
    if (v && v.strength > 0) {
      const dx = b.x - v.x;
      const dz = b.z - v.z;
      const d = Math.hypot(dx, dz);
      if (d < v.radius && d > 0.05) {
        const k = v.strength * (1 - d / v.radius);
        // Tangential swirl + a draw toward the centre.
        tx += (-dz / d) * 2.2 * k - (dx / d) * 1.1 * k;
        tz += (dx / d) * 2.2 * k - (dz / d) * 1.1 * k;
      }
    }
    const a = 1 - Math.exp(-H_DRAG * dt);
    b.vx += (tx - b.vx) * a;
    b.vz += (tz - b.vz) * a;
  } else {
    b.vy -= 9.81 * dt;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  b.yaw += b.spin * dt;
}

// ── Renderer ────────────────────────────────────────────────────────────────

export interface FounderFxShip {
  id: string;
  type: ShipType;
  position: { x: number; y: number; z: number };
  rotation: number;
  pitch?: number;
  sinking?: boolean;
  sinkProgress?: number;
}

export interface FounderFxSources {
  surfaceY(x: number, z: number): number;
  /** Island terrain height, -Infinity over open sea. */
  groundY?(x: number, z: number): number;
  /** The drawn hull root (hull-local frame of the hatches), when built. */
  shipRoot(shipId: string): THREE.Object3D | null;
  /** Prevailing wind: yaw it blows TOWARD, strength 0..1. */
  wind(): { direction: number; strength: number };
}

interface Track {
  type: ShipType;
  plan: DebrisSeed[];
  released: boolean[];
  burstCarry: number;
  plungeAt: number;
  px: number;
  pz: number;
  radius: number;
  lastSeen: number;
  bursts: number;
}

interface Ring { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; x: number; z: number; age: number; radius: number }

/** Full-scale wind at strength 1, m/s (the sailing model's breeze). */
const WIND_MS = 9;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  // Log-spiral arms turning in, a broken foam band, open eye in the middle.
  float arms = sin(a * 5.0 + log(max(r, 0.02)) * 7.0 + uTime * 2.6);
  float grain = h21(floor(vec2(a * 18.0 + uTime * 1.5, r * 22.0)));
  float foam = smoothstep(0.15, 0.85, arms * 0.5 + 0.5) * (0.55 + 0.45 * grain);
  float band = smoothstep(0.12, 0.3, r) * (1.0 - smoothstep(0.7, 1.0, r));
  float alpha = foam * band * uAlpha;
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(mix(vec3(0.78, 0.86, 0.88), vec3(0.96, 0.98, 0.99), foam), alpha);
}`;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class FounderFx {
  private readonly tracks = new Map<string, Track>();
  private readonly bodies: FloatingBody[] = [];
  private readonly rings: Ring[] = [];
  private readonly barrels: THREE.InstancedMesh;
  private readonly boxes: THREE.InstancedMesh;
  private burstsTotal = 0;
  private plungesTotal = 0;
  private bubbleCarry = 0;

  constructor(private readonly scene: THREE.Scene, private readonly particles: FloodParticleSink) {
    const wood = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.02 });
    // Barrel: a bellied lathe on its side (axis along local x).
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 6; i += 1) {
      const u = i / 6;
      pts.push(new THREE.Vector2(0.25 + 0.07 * Math.sin(u * Math.PI), (u - 0.5) * 0.82));
    }
    const barrelGeo = new THREE.LatheGeometry(pts, 10).rotateZ(Math.PI / 2);
    this.barrels = new THREE.InstancedMesh(barrelGeo, wood, FOUNDER_DEBRIS_MAX);
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wood, FOUNDER_DEBRIS_MAX);
    for (const m of [this.barrels, this.boxes]) {
      m.name = 'founder-debris';
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, _c.set(0xffffff));
      scene.add(m);
    }
  }

  /** Live counts for the probe and the audio lane. */
  stats(): { tracked: number; debris: number; rings: number; bursts: number; plunges: number; drawn: number } {
    return {
      tracked: this.tracks.size,
      debris: this.bodies.length,
      rings: this.rings.filter((r) => r.mesh.visible).length,
      bursts: this.burstsTotal,
      plunges: this.plungesTotal,
      drawn: this.barrels.count + this.boxes.count,
    };
  }

  /** Floating wreckage (read-only), e.g. for audio or a probe. */
  getDebris(): readonly FloatingBody[] {
    return this.bodies;
  }

  reset(): void {
    this.tracks.clear();
    this.bodies.length = 0;
    for (const r of this.rings) r.mesh.visible = false;
    this.barrels.count = 0;
    this.boxes.count = 0;
    this.barrels.visible = false;
    this.boxes.visible = false;
  }

  update(dt: number, t: number, ships: readonly FounderFxShip[], cam: THREE.Vector3, src: FounderFxSources): void {
    const step = Math.min(0.05, Math.max(0, dt));
    for (const ship of ships) {
      if (!ship.sinking) continue;
      const p = ship.sinkProgress ?? 0;
      if (p >= 1) continue;
      let tr = this.tracks.get(ship.id);
      if (!tr) {
        const dx = ship.position.x - cam.x;
        const dz = ship.position.z - cam.z;
        if (dx * dx + dz * dz > FOUNDER_FX_RANGE * FOUNDER_FX_RANGE) continue;
        const plan = founderDebrisPlan(ship.id, ship.type);
        tr = {
          type: ship.type, plan, released: plan.map(() => false), burstCarry: 0,
          plungeAt: -1, px: 0, pz: 0, radius: SHIP_STATS[ship.type].length * 0.35, lastSeen: t, bursts: 0,
        };
        this.tracks.set(ship.id, tr);
      }
      tr.lastSeen = t;
      const root = src.shipRoot(ship.id);
      if (root) root.updateMatrixWorld();
      const toWorld = (lx: number, ly: number, lz: number, out: THREE.Vector3) => {
        if (root) return root.localToWorld(out.set(lx, ly, lz));
        const c = Math.cos(ship.rotation);
        const s = Math.sin(ship.rotation);
        return out.set(
          ship.position.x + lx * c + lz * s,
          ship.position.y + ly - lz * Math.sin(ship.pitch ?? 0),
          ship.position.z + lz * c - lx * s,
        );
      };
      // Hatch air-burst: two spray columns, envelope peaking mid-window.
      if (p >= FOUNDER_BURST_F[0] && p < FOUNDER_BURST_F[1]) {
        const u = (p - FOUNDER_BURST_F[0]) / (FOUNDER_BURST_F[1] - FOUNDER_BURST_F[0]);
        const env = Math.sin(Math.PI * Math.min(1, u * 1.25));
        tr.burstCarry += step * 70 * env;
        if (tr.bursts === 0) { tr.bursts = 1; this.burstsTotal += 1; }
        const hatches = founderHatches(ship.type);
        while (tr.burstCarry >= 1) {
          tr.burstCarry -= 1;
          const h = hatches[Math.random() < 0.55 ? 0 : 1];
          toWorld(
            h.x + (Math.random() * 2 - 1) * h.halfX * 0.7,
            h.y,
            h.z + (Math.random() * 2 - 1) * h.halfZ * 0.7,
            _v,
          );
          const up = 5.5 + Math.random() * 5 * env;
          this.particles.emitFloodSpray(
            _v.x, _v.y, _v.z,
            (Math.random() * 2 - 1) * 1.1, up, (Math.random() * 2 - 1) * 1.1,
            0.1 + Math.random() * 0.12,
          );
          if (Math.random() < 0.2) this.particles.emitFloodSplash(_v.x, _v.y + 0.2, _v.z, env);
        }
      }
      // Plunge: note where she went down.
      if (p >= FOUNDER_PLUNGE_F && tr.plungeAt < 0) {
        toWorld(0, 0, 0, _v);
        tr.px = _v.x;
        tr.pz = _v.z;
        tr.plungeAt = t;
        this.plungesTotal += 1;
        this.spawnRing(tr.px, tr.pz, tr.radius);
      }
      // Release seeded wreckage.
      for (let i = 0; i < tr.plan.length; i += 1) {
        if (tr.released[i] || p < tr.plan[i].at) continue;
        tr.released[i] = true;
        if (this.bodies.length >= FOUNDER_DEBRIS_MAX) continue;
        const d = tr.plan[i];
        const hy = d.stage === 'burst' ? founderHatches(ship.type)[0].y : SHIP_STATS[ship.type].height + 0.2;
        toWorld(d.lx, hy, d.lz, _v);
        const surf = src.surfaceY(_v.x, _v.z);
        const c = Math.cos(ship.rotation);
        const s = Math.sin(ship.rotation);
        this.bodies.push({
          kind: d.kind,
          x: _v.x,
          // A piece shed from a deck already under comes up from below it.
          y: Math.max(_v.y, surf - 0.35),
          z: _v.z,
          vx: d.vx * c + d.vz * s,
          vy: d.vy,
          vz: d.vz * c - d.vx * s,
          yaw: d.yaw,
          spin: d.spin,
          scale: d.scale,
          tone: d.tone,
          age: 0,
          sx: 0,
          sz: 0,
          stranded: false,
        });
      }
    }
    // Hulls that left the list: keep their plunge (column, ring) until done.
    for (const [id, tr] of this.tracks) {
      const done = tr.plungeAt >= 0 ? t - tr.plungeAt > VORTEX_RING_S : t - tr.lastSeen > 5;
      if (done && t - tr.lastSeen > 1) this.tracks.delete(id);
    }

    // Bubble column over every live plunge.
    let vortex: FloatEnv['vortex'] = null;
    for (const tr of this.tracks.values()) {
      if (tr.plungeAt < 0) continue;
      const age = t - tr.plungeAt;
      if (age < VORTEX_RING_S) {
        const k = Math.max(0, 1 - age / VORTEX_RING_S);
        if (!vortex || k > vortex.strength) vortex = { x: tr.px, z: tr.pz, strength: k, radius: tr.radius * 1.6 };
      }
      if (age >= BUBBLE_COLUMN_S) continue;
      const k = 1 - age / BUBBLE_COLUMN_S;
      this.bubbleCarry += step * (30 + 50 * k);
      while (this.bubbleCarry >= 1) {
        this.bubbleCarry -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * tr.radius * (0.35 + 0.65 * k);
        const x = tr.px + Math.cos(a) * r;
        const z = tr.pz + Math.sin(a) * r;
        const y = src.surfaceY(x, z);
        this.particles.emitFloodBubbles(x, y, z, k);
        if (Math.random() < 0.18 * k) this.particles.emitFloodSplash(x, y + 0.05, z, k);
      }
    }

    // Float the wreckage.
    const w = src.wind();
    const env: FloatEnv = {
      surfaceY: src.surfaceY,
      groundY: src.groundY,
      windX: Math.sin(w.direction) * w.strength * WIND_MS,
      windZ: Math.cos(w.direction) * w.strength * WIND_MS,
      vortex,
    };
    for (let i = this.bodies.length - 1; i >= 0; i -= 1) {
      const b = this.bodies[i];
      stepFloatingBody(b, step, env);
      if (b.age >= DEBRIS_LIFE_S) this.bodies.splice(i, 1);
    }
    this.draw(step);
    this.updateRings(step, src);
  }

  private draw(_dt: number): void {
    let nb = 0;
    let nx = 0;
    for (const b of this.bodies) {
      const tilt = 0.8;
      _e.set(Math.atan(b.sz) * tilt, b.yaw, -Math.atan(b.sx) * tilt, 'YXZ');
      _q.setFromEuler(_e);
      if (b.kind === 'barrel') {
        _s.setScalar(b.scale);
        _m.compose(_v.set(b.x, b.y, b.z), _q, _s);
        this.barrels.setMatrixAt(nb, _m);
        this.barrels.setColorAt(nb, _c.setHSL(0.075, 0.42, 0.2 + b.tone * 0.08));
        nb += 1;
      } else {
        if (b.kind === 'crate') _s.set(0.62, 0.52, 0.62).multiplyScalar(b.scale);
        else _s.set(0.26, 0.07, 2.1 * b.scale);
        _m.compose(_v.set(b.x, b.y, b.z), _q, _s);
        this.boxes.setMatrixAt(nx, _m);
        this.boxes.setColorAt(nx, b.kind === 'crate'
          ? _c.setHSL(0.085, 0.38, 0.3 + b.tone * 0.08)
          : _c.setHSL(0.07, 0.3, 0.2 + b.tone * 0.07));
        nx += 1;
      }
    }
    for (const [m, n] of [[this.barrels, nb], [this.boxes, nx]] as const) {
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  }

  private spawnRing(x: number, z: number, radius: number): void {
    let ring = this.rings.find((r) => !r.mesh.visible);
    if (!ring) {
      if (this.rings.length >= FOUNDER_RING_MAX) {
        ring = this.rings.reduce((a, b) => (a.age > b.age ? a : b));
      } else {
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
          vertexShader: RING_VERT,
          fragmentShader: RING_FRAG,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 1, 1).rotateX(-Math.PI / 2), mat);
        mesh.name = 'founder-vortex';
        mesh.renderOrder = 5;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        ring = { mesh, mat, x, z, age: 0, radius };
        this.rings.push(ring);
      }
    }
    ring.x = x;
    ring.z = z;
    ring.age = 0;
    ring.radius = radius;
    ring.mesh.visible = true;
  }

  private updateRings(dt: number, src: FounderFxSources): void {
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      if (r.age >= VORTEX_RING_S) { r.mesh.visible = false; continue; }
      const u = r.age / VORTEX_RING_S;
      const size = r.radius * (0.55 + 1.1 * Math.sqrt(u));
      r.mesh.position.set(r.x, src.surfaceY(r.x, r.z) + 0.12, r.z);
      r.mesh.scale.setScalar(size);
      r.mat.uniforms.uTime.value += dt;
      r.mat.uniforms.uAlpha.value = Math.min(1, r.age / 0.6) * (1 - u * u) * 0.85;
    }
  }
}
