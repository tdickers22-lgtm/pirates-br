// SHIP OBJECT MOTION (b4.3d, animations-12, vm:ships:5): the parts of a hull
// that move because the crew moved them.
//
//   * A deck gun jumps back on its breeching ropes when it fires: the carriage
//     slides RECOIL_BACK_M along -barrel in RECOIL_PEAK_S, the muzzle kicks up
//     RECOIL_KICK_RAD, and the crew run it out again over RECOIL_RUNOUT_S. It
//     used to be a flash and a ball out of a frozen gun.
//   * Gunport lids are shut on a quiet hull, swing open while a gunner mans
//     the gun, are open on the fire edge whatever came before, and close again
//     once the gun has stood unmanned for LID_HOLD_S.
//   * The capstan turns with the rope and only with the rope: zero idle spin
//     (it crept at 0.08 rad/s with nobody on it), the raise turns it +Y at the
//     rate the cable comes in, the drop spins it the other way, fast, decaying
//     as the anchor pays out over ANCHOR_PAYOUT_SECONDS.
//   * The wheel follows the rudder with a WHEEL_TAU_S lag (0.1-0.2 s), so it
//     has weight without hiding what the helmsman commanded.
//   * Damage reads at range (vm:ships:6): the LOD1/LOD2 instanced sails (the
//     hull past ~30 m) cut the same chainshot holes as the LOD0 cloth, and a
//     ball that strikes at the rail line splinters that run of the rail.
//
// Pure maths on top, a small per-hull tracker below; the renderer calls it from
// its per-frame loop (ShipRenderer hook) and the no-inversion gate drives the
// same functions (scripts/test-anim-no-inversion.mjs, ship object motion).
import * as THREE from 'three';
import { ANCHOR_PAYOUT_SECONDS } from '../../../shared/anchor.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SHIP_STATS } from '../../../shared/constants/index.js';
import { getHullProfile } from '../../../shared/hull.js';
import type { ShipType } from '../../../shared/types/index.js';
import { GUNPORT_LID_OPEN, KIT_HINGE, type KitHinge } from './kit.js';
import { sheerHalfWidthAt } from './geometry.js';
import { clothTornAt, sailTearAmount } from './sailCloth.js';

export const RECOIL_BACK_M = 0.52;
export const RECOIL_PEAK_S = 0.08;
export const RECOIL_RUNOUT_S = 1.2;
export const RECOIL_KICK_RAD = 3 * Math.PI / 180;
/** Settle time of the muzzle kick (it is back on the aim long before the run-out ends). */
export const RECOIL_KICK_SETTLE_S = 0.3;
/** Seconds a fired or abandoned gun keeps its lid open before it is shut. */
export const LID_HOLD_S = 6;
export const LID_OPEN_S = 0.25;
export const LID_CLOSE_S = 1.4;
/** Whole capstan turns from anchor down to anchor catted. */
export const CAPSTAN_RAISE_TURNS = 3;
/** The drum chases the rope with this lag (smooths the 20 Hz progress ticks). */
export const CAPSTAN_TAU_S = 0.12;
/** Helm wheel lag behind the rudder reading (the spec band is 0.1-0.2 s). */
export const WHEEL_TAU_S = 0.15;
/** A cooldown that jumps up by more than this between frames is a shot. */
const FIRE_EDGE_JUMP_S = 0.25;
/** A tracker that missed this much clock (hull was past the detail band) re-baselines. */
const STALE_GAP_S = 0.3;

export interface CannonRecoil { back: number; kick: number }

/** Carriage travel (m, along -barrel) and muzzle-up kick (rad) `t` s after the shot. */
export function cannonRecoil(t: number, out: CannonRecoil = { back: 0, kick: 0 }): CannonRecoil {
  out.back = 0; out.kick = 0;
  if (!(t >= 0) || t >= RECOIL_PEAK_S + RECOIL_RUNOUT_S) return out;
  if (t <= RECOIL_PEAK_S) {
    const k = t / RECOIL_PEAK_S;
    const e = 1 - (1 - k) * (1 - k); // the blast: fastest at the shot, stops at the breeching
    out.back = RECOIL_BACK_M * e;
    out.kick = RECOIL_KICK_RAD * e;
    return out;
  }
  const k = (t - RECOIL_PEAK_S) / RECOIL_RUNOUT_S;
  out.back = RECOIL_BACK_M * (1 - k * k * (3 - 2 * k)); // hauled out on the gun tackles
  const ks = Math.min(1, (t - RECOIL_PEAK_S) / RECOIL_KICK_SETTLE_S);
  out.kick = RECOIL_KICK_RAD * (1 - ks) * (1 - ks);
  return out;
}

/** Exponential follow factor for the helm wheel (and the rudder stock with it). */
export function wheelFollowAlpha(dt: number): number {
  return 1 - Math.exp(-Math.max(0, dt) / WHEEL_TAU_S);
}

/** The deck gun as ShipRenderer builds it: root on the carriage, yaw then pitch pivots (barrel along local +X). */
export interface GunPivots { root: THREE.Object3D; yawPivot: THREE.Object3D; pitchPivot: THREE.Object3D }

interface GunState {
  sinceFire: number;
  prevCooldown: number;
  manned: boolean;
  lid: number;
  appliedKick: number;
  rest: THREE.Vector3 | null;
}

const recoilScratch: CannonRecoil = { back: 0, kick: 0 };
const offScratch = new THREE.Vector3();
const hingeScratch = new THREE.Matrix4();
const instScratch = new THREE.Matrix4();

/** Capstan drum that follows the anchor cable. Returns the rotation.y step each frame. */
export class CapstanMotion {
  angle = 0;
  target = 0;
  omega = 0;
  private prevAnchored: boolean | null = null;
  private prevProgress = 0;
  private payoutT = Infinity;
  private payoutFrom = 0;
  private payoutTurns = 0;

  step(anchored: boolean, raiseProgress: number, dt: number): number {
    const p = Number.isFinite(raiseProgress) ? Math.max(0, Math.min(1, raiseProgress)) : 0;
    if (this.prevAnchored !== null) {
      if (!this.prevAnchored && anchored && p < 0.05) this.startPayout(CAPSTAN_RAISE_TURNS);
      else if (anchored && p > this.prevProgress) this.target += (p - this.prevProgress) * CAPSTAN_RAISE_TURNS * Math.PI * 2;
      else if (anchored && p < this.prevProgress - 1e-3) this.startPayout((this.prevProgress - p) * CAPSTAN_RAISE_TURNS);
    }
    this.prevAnchored = anchored;
    this.prevProgress = p;
    if (this.payoutT < ANCHOR_PAYOUT_SECONDS) {
      this.payoutT = Math.min(ANCHOR_PAYOUT_SECONDS, this.payoutT + Math.max(0, dt));
      const k = this.payoutT / ANCHOR_PAYOUT_SECONDS;
      this.target = this.payoutFrom - this.payoutTurns * Math.PI * 2 * (1 - (1 - k) ** 3); // runs out, then the cable slackens
    }
    if (!(dt > 0)) { this.omega = 0; return 0; }
    const before = this.angle;
    const gap = this.target - this.angle;
    this.angle = Math.abs(gap) < 1e-5 ? this.target : this.angle + gap * (1 - Math.exp(-dt / CAPSTAN_TAU_S));
    this.omega = (this.angle - before) / dt;
    return this.angle - before;
  }

  private startPayout(turns: number): void {
    // A payout already running keeps its remaining travel.
    this.payoutFrom = this.target;
    this.payoutTurns = turns;
    this.payoutT = 0;
  }
}

/** Per-hull motion state: guns (recoil + lids) and the capstan. */
export class ShipMotion {
  readonly guns: GunState[] = [];
  readonly capstan = new CapstanMotion();
  private lidSets: KitHinge[] = [];
  private lastT = -Infinity;

  /** The hinged gunport lid instances of the kit (LOD0 and the level roots). */
  bindLids(roots: ReadonlyArray<THREE.Object3D | null | undefined>): void {
    this.lidSets = [];
    for (const r of roots) {
      r?.traverse((o) => {
        const h = o.userData[KIT_HINGE] as KitHinge | undefined;
        if (h && h.node === 'gunport_lid') this.lidSets.push(h);
      });
    }
    for (const g of this.guns) g.lid = NaN; // force a write on the next update
  }

  private gun(i: number): GunState {
    while (this.guns.length <= i) {
      this.guns.push({ sinceFire: Infinity, prevCooldown: NaN, manned: false, lid: NaN, appliedKick: 0, rest: null }); // NaN: the first update writes the pose over the kit's open mount
    }
    return this.guns[i];
  }

  /** Read the wire for fire edges and step the lids. `manned(i)` = a gunner is on gun i. */
  update(cooldowns: ReadonlyArray<number> | undefined, manned: (i: number) => boolean, t: number, dt: number): void {
    const stale = !(t - this.lastT <= STALE_GAP_S);
    this.lastT = t;
    const n = Math.max(cooldowns?.length ?? 0, this.guns.length);
    for (let i = 0; i < n; i++) {
      const g = this.gun(i);
      const cd = cooldowns?.[i];
      g.sinceFire += Math.max(0, dt);
      if (Number.isFinite(cd)) {
        if (!stale && Number.isFinite(g.prevCooldown) && (cd as number) > g.prevCooldown + FIRE_EDGE_JUMP_S) g.sinceFire = 0;
        g.prevCooldown = cd as number;
      }
      g.manned = manned(i);
      const fired = g.sinceFire === 0;
      const wantOpen = g.manned || g.sinceFire < LID_HOLD_S;
      const prev = g.lid;
      const cur = Number.isFinite(prev) ? prev : 0;
      let next: number;
      if (fired) next = GUNPORT_LID_OPEN; // the shot goes out through an open port, whatever came before
      else if (wantOpen) next = Math.max(GUNPORT_LID_OPEN, cur - (Math.abs(GUNPORT_LID_OPEN) / LID_OPEN_S) * dt);
      else next = Math.min(0, cur + (Math.abs(GUNPORT_LID_OPEN) / LID_CLOSE_S) * dt);
      g.lid = next;
      if (next !== prev) this.writeLid(i, next);
    }
  }

  /** Lid angle about its hinge (0 shut, GUNPORT_LID_OPEN open). */
  lidAngle(i: number): number { const a = this.guns[i]?.lid; return a !== undefined && Number.isFinite(a) ? a : 0; }

  private writeLid(i: number, angle: number): void {
    for (const h of this.lidSets) {
      if (i >= h.pre.length) continue;
      instScratch.copy(h.pre[i]).multiply(hingeScratch.makeRotationX(angle)).multiply(h.post[i]);
      h.mesh.setMatrixAt(i, instScratch);
      h.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Aim gun `i` (the old per-frame lerp) and lay the recoil on top: the root
   * slides back along the barrel's horizontal heading, the pitch pivot carries
   * the kick, and the aim lerp never eats it (the applied kick is taken out
   * before the lerp and put back after).
   */
  aimGun(i: number, gun: GunPivots, desiredYaw: number, desiredPitch: number, alpha: number): void {
    const g = this.gun(i);
    if (!g.rest) g.rest = gun.root.position.clone();
    const yaw = gun.yawPivot.rotation.y;
    let dy = desiredYaw - yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    gun.yawPivot.rotation.y = yaw + dy * alpha;
    const r = cannonRecoil(g.sinceFire, recoilScratch);
    const base = gun.pitchPivot.rotation.z - g.appliedKick;
    gun.pitchPivot.rotation.z = base + (desiredPitch - base) * alpha + r.kick;
    g.appliedKick = r.kick;
    const a = gun.yawPivot.rotation.y;
    // Barrel heading in the root frame is (cos a, 0, -sin a); the carriage runs back along its negative.
    offScratch.set(-Math.cos(a) * r.back, 0, Math.sin(a) * r.back).applyQuaternion(gun.root.quaternion);
    gun.root.position.copy(g.rest).add(offScratch);
  }
}

const motions = new WeakMap<object, ShipMotion>();
/** The tracker for one rendered hull (keyed by its mesh group object). */
export function shipMotionOf(mesh: object): ShipMotion {
  let m = motions.get(mesh);
  if (!m) { m = new ShipMotion(); motions.set(mesh, m); }
  return m;
}

// ── TORN SAILS AT RANGE (vm:ships:6) ───────────────────────────────────────
// Past ~30 m a hull draws its sails as ONE InstancedMesh of bellied cards
// (lod1Sails / lod2Sails). Those had no tear, so a rig shot to 35% looked whole
// at 60 m. The same alpha cut as the LOD0 cloth (sailCloth.ts CLOTH_FRAGMENT:
// value noise on a 5 x 7 lattice, 6% bolt-rope border, threshold
// sailTearAmount) on the card's uv, seeded per instance from gl_InstanceID.

/** Tear seed of LOD sail instance `i` (the vertex shader derives the same). */
export function lodSailSeed(i: number): number { return (i * 3.17 + 1.3) % 11; }

/** JS mirror of the LOD sail alpha cut: true = a hole at (u01 across, s down) on instance `i`. */
export function lodSailTornAt(u01: number, s: number, tear: number, i: number): boolean {
  return clothTornAt(u01, s, tear, lodSailSeed(i));
}

export const LOD_SAIL_TEAR_VERTEX = /* glsl */ `
  vLodSail = vec2(uv.x, 1.0 - uv.y);
#if __VERSION__ >= 300
  vLodSeed = mod(float(gl_InstanceID) * 3.17 + 1.3, 11.0);
#else
  vLodSeed = 1.3;
#endif
`;

export const LOD_SAIL_TEAR_FRAGMENT = /* glsl */ `
  if (uLodTear > 0.0 && vLodSail.x > 0.06 && vLodSail.x < 0.94 && vLodSail.y > 0.06 && vLodSail.y < 0.94) {
    vec2 ltP = vec2(vLodSail.x * 5.0 + vLodSeed, vLodSail.y * 7.0 + vLodSeed * 0.37);
    vec2 ltI = floor(ltP);
    vec2 ltF = fract(ltP);
    ltF = ltF * ltF * (3.0 - 2.0 * ltF);
    float ltA0 = fract(sin(dot(ltI, vec2(127.1, 311.7))) * 43758.5453);
    float ltA1 = fract(sin(dot(ltI + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float ltA2 = fract(sin(dot(ltI + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float ltA3 = fract(sin(dot(ltI + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    if (mix(mix(ltA0, ltA1, ltF.x), mix(ltA2, ltA3, ltF.x), ltF.y) < uLodTear) discard;
  }
`;

export interface LodSailTear { value: number }

/** Give an instanced LOD sail material the chainshot alpha cut (one uniform per hull material). */
export function attachLodSailTear(material: THREE.Material): LodSailTear {
  const uLodTear: LodSailTear = { value: 0 };
  material.userData.lodSailTear = uLodTear;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLodTear = uLodTear;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLodSail;\nvarying float vLodSeed;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LOD_SAIL_TEAR_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLodTear;\nvarying vec2 vLodSail;\nvarying float vLodSeed;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${LOD_SAIL_TEAR_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => 'lod-sail-tear-v1';
  return uLodTear;
}

/** Per-frame: the hull's sail integrity -> the LOD cut threshold (same curve as LOD0). */
export function setLodSailTear(u: LodSailTear | undefined, sailIntegrity: number): void {
  if (u) u.value = sailTearAmount(sailIntegrity);
}

// ── SPLINTERED RAILS (vm:ships:6) ──────────────────────────────────────────
// A ball that strikes at the rail line (the 0.34 m bulwark + 0.1 m cap rail
// ShipRenderer lofts on the sheer) breaks that run: a scorched gap over the
// rail, two snapped rail ends kinked up, and a fan of fresh-wood splinters.
// Seeded by hull id + spot, so every client sees the same break; one
// vertex-coloured draw per break, at most RAIL_BREAKS_MAX per hull.

/** Rail top above the hull's H: bulwark 0.34 + cap rail 0.1 (ShipRenderer buildShip). */
export const RAIL_TOP_ABOVE_H = 0.44;
/** How far off the rail line (outboard / inboard / above) a strike still breaks it. */
export const RAIL_STRIKE_REACH_M = 0.7;
/** Strikes below the rail top deeper than this hit planking, not the rail. */
export const RAIL_STRIKE_BELOW_M = 0.45;
/** Two breaks closer than this on one side are the same break. */
export const RAIL_BREAK_SPACING_M = 0.9;
export const RAIL_BREAKS_MAX = 6;

export interface RailRun { railTopY: number; halfDeckZ: number; halfWidthAt: (z: number) => number }

const railRuns = new Map<ShipType, RailRun>();
/** The rail run of a class, in hull-local metres (the same sheer the bulwark is lofted on). */
export function railRunFor(type: ShipType): RailRun {
  let r = railRuns.get(type);
  if (!r) {
    const stats = SHIP_STATS[type];
    const profile = getHullProfile(type);
    r = { railTopY: stats.height + RAIL_TOP_ABOVE_H, halfDeckZ: stats.length * 0.45, halfWidthAt: (z) => sheerHalfWidthAt(profile, z) };
    railRuns.set(type, r);
  }
  return r;
}

export interface RailSite { side: -1 | 1; z: number }

/** Where a hull-local strike breaks the rail, or null if it hit anything else. */
export function railSplinterSite(local: { x: number; y: number; z: number }, run: RailRun): RailSite | null {
  if (!Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) return null;
  if (Math.abs(local.z) > run.halfDeckZ) return null;
  if (local.y < run.railTopY - RAIL_STRIKE_BELOW_M || local.y > run.railTopY + RAIL_STRIKE_REACH_M) return null;
  const hw = run.halfWidthAt(local.z);
  if (Math.abs(Math.abs(local.x) - hw) > RAIL_STRIKE_REACH_M) return null;
  return { side: local.x < 0 ? -1 : 1, z: local.z };
}

function railRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHAR = new THREE.Color(0x2b1d12);
const FRESH = new THREE.Color(0xd2aa72);
const SPLIT = new THREE.Color(0x8a5a32);
let railBreakMat: THREE.MeshStandardMaterial | null = null;
function railBreakMaterial(): THREE.MeshStandardMaterial {
  if (!railBreakMat) {
    railBreakMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    railBreakMat.name = 'rail-splinters';
  }
  return railBreakMat;
}

function painted(geo: THREE.BufferGeometry, color: THREE.Color, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  return g;
}

const rbQ = new THREE.Quaternion();
const rbE = new THREE.Euler();
const rbP = new THREE.Vector3();
const rbS = new THREE.Vector3();
const rbM = new THREE.Matrix4();

/** One broken rail run at hull-local z on `side`, seeded (same seed -> same splinters). */
export function buildRailBreak(seed: number, side: -1 | 1, z: number, run: RailRun): THREE.Mesh {
  const rnd = railRng(seed);
  const top = run.railTopY;
  const x0 = side * run.halfWidthAt(z);
  const gap = 0.55 + rnd() * 0.5;
  const parts: THREE.BufferGeometry[] = [];
  // The scorched gap: encloses the cap rail and the top of the bulwark (centred or inboard-thick).
  rbP.set(x0 - side * 0.06, top - 0.08, z); rbQ.identity(); rbS.set(0.34, 0.2, gap);
  parts.push(painted(new THREE.BoxGeometry(1, 1, 1), CHAR, rbM.compose(rbP, rbQ, rbS)));
  // The two snapped ends of the rail, kinked up and outboard.
  for (const end of [-1, 1] as const) {
    const len = 0.28 + rnd() * 0.16;
    const kink = (0.35 + rnd() * 0.4) * -end; // the free end rises toward the gap
    rbE.set(kink, 0, side * (0.1 + rnd() * 0.25), 'XYZ'); rbQ.setFromEuler(rbE);
    rbP.set(x0 + side * 0.02, top + 0.02 + Math.abs(Math.sin(kink)) * len * 0.5, z + end * (gap * 0.5 - len * 0.35));
    rbS.set(0.18, 0.09, len);
    parts.push(painted(new THREE.BoxGeometry(1, 1, 1), SPLIT, rbM.compose(rbP, rbQ, rbS)));
  }
  // Splinters: thin four-sided spikes fanned up and outboard from the break.
  const count = 7 + Math.floor(rnd() * 4);
  for (let k = 0; k < count; k++) {
    const len = 0.22 + rnd() * 0.36;
    const r = 0.018 + rnd() * 0.026;
    const zz = z + (rnd() - 0.5) * gap * 0.9;
    rbE.set((rnd() - 0.5) * 0.9, rnd() * Math.PI, -side * (0.15 + rnd() * 0.75), 'XYZ'); rbQ.setFromEuler(rbE);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(rbQ);
    rbP.set(x0 + (rnd() - 0.4) * 0.16 * side + dir.x * len * 0.5, top - 0.06 + dir.y * len * 0.5, zz + dir.z * len * 0.5);
    rbS.set(r, len, r);
    parts.push(painted(new THREE.ConeGeometry(1, 1, 4, 1), k % 3 === 0 ? SPLIT : FRESH, rbM.compose(rbP, rbQ, rbS)));
  }
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, railBreakMaterial());
  mesh.name = 'rail-break';
  mesh.castShadow = true;
  return mesh;
}

function railSeed(shipId: string, side: number, z: number): number {
  let h = 2166136261 >>> 0;
  const key = `${shipId}|${side}|${Math.round(z * 4)}`;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** The broken rail runs of one hull. */
export class RailBreaks {
  private readonly sites: Array<{ side: -1 | 1; z: number; mesh: THREE.Mesh }> = [];

  /** A strike at hull-local `local`: break the rail there (returns the new break) or null. */
  strike(parent: THREE.Object3D, local: { x: number; y: number; z: number }, run: RailRun, shipId: string): THREE.Mesh | null {
    const site = railSplinterSite(local, run);
    if (!site) return null;
    if (this.sites.some((s) => s.side === site.side && Math.abs(s.z - site.z) < RAIL_BREAK_SPACING_M)) return null;
    const mesh = buildRailBreak(railSeed(shipId, site.side, site.z), site.side, site.z, run);
    parent.add(mesh);
    this.sites.push({ side: site.side, z: site.z, mesh });
    while (this.sites.length > RAIL_BREAKS_MAX) {
      const old = this.sites.shift()!;
      old.mesh.removeFromParent();
      old.mesh.geometry.dispose();
    }
    return mesh;
  }

  get count(): number { return this.sites.length; }
}

const railBreaks = new WeakMap<object, RailBreaks>();
/** The rail breaks of one rendered hull (keyed by its mesh group object). */
export function railBreaksOf(mesh: object): RailBreaks {
  let r = railBreaks.get(mesh);
  if (!r) { r = new RailBreaks(); railBreaks.set(mesh, r); }
  return r;
}
