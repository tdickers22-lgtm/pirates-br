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
//
// Pure maths on top, a small per-hull tracker below; the renderer calls it from
// its per-frame loop (ShipRenderer hook) and the no-inversion gate drives the
// same functions (scripts/test-anim-no-inversion.mjs, ship object motion).
import * as THREE from 'three';
import { ANCHOR_PAYOUT_SECONDS } from '../../../shared/anchor.js';
import { GUNPORT_LID_OPEN, KIT_HINGE, type KitHinge } from './kit.js';

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
