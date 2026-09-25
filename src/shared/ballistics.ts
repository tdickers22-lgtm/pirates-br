// Shared ballistics (b2.1f, D17, physics-06 / physics-07).
//
// ONE model for every round shot in flight, read by the server step
// (PhysicsSystem.updateProjectiles), the gun (WeaponSystem.fireShipCannon), the
// bot gunner's solver (BotPirate.computeCannonAim) and the client's render
// extrapolation (Game.getProjectileRenderPosition).
//
// The model is Sea of Thieves' own: gravity is the only acceleration, no drag
// (a 24-pounder at these ranges loses little, and a drag-free arc is the one a
// player can learn and lead). g is the real 9.81 m/s^2, not the walker's -18.
// The launch velocity is the barrel's muzzle velocity PLUS everything the gun is
// doing when it fires: the hull's velocity through the water, the yaw rate
// swinging the muzzle (omega x r), and the heave / roll / pitch rates lifting or
// dropping it. There is no invented upward kick: the ball leaves along the barrel
// in the ship's frame.
//
// Integration is closed-form SUVAT per tick (x += v dt + 1/2 a dt^2, v += a dt),
// exact for constant acceleration, so a server that steps it at any dt and a
// client that jumps straight to t agree to rounding error.

import type { Ship, Vec3, ProjectileType } from './types/index.js';
import { SHIP_STATS } from './constants/index.js';
import { getCannonDeckLocalPosition } from './interactions.js';

/** Gravity on round shot, chain and firebombs (m/s^2, magnitude). */
export const BALLISTIC_G = 9.81;
/** Firearm rounds keep their long-standing flat drop (0.3 x the old 18): the
 *  firearm lane tunes those, and a musket ball at 5.4 is the reticle players
 *  already know. Only the great guns follow D17. */
export const BULLET_G = 5.4;
/** Muzzle speed of a ship's gun (m/s). Chosen so the maximum range at the
 *  barrel's top elevation (SHIP.CANNON_PITCH_MAX 0.62 rad) from a gun deck
 *  2.6-3.9 m above the sea is 305-308 m: the 300-312 m engagement spacing the
 *  storm phases were tuned around stays put (D17). */
export const CANNON_MUZZLE_SPEED = 56;

/** Grazing skip (physics-07): a ball meeting the sea flatter than this and
 *  faster than SKIP_MIN_SPEED ricochets off it, at most SKIP_MAX times. */
export const SKIP_MAX_INCIDENCE = 8 * Math.PI / 180;
export const SKIP_MIN_SPEED = 25;
export const SKIP_MAX = 2;
/** Energy the sea keeps on a skip: vertical restitution and horizontal share. */
export const SKIP_RESTITUTION = 0.4;
export const SKIP_HORIZONTAL_KEEP = 0.7;

export function projectileGravity(type: ProjectileType): number {
  return type === 'bullet' ? BULLET_G : BALLISTIC_G;
}

/** Hull rates the physics step measured this tick (heave in m/s, roll and pitch
 *  in rad/s, same sign conventions as Ship.roll / Ship.pitch). */
export interface HullRates { heaveRate: number; rollRate: number; pitchRate: number }

// Server-side registry: PhysicsSystem records the rates each tick, the gun and
// the bot gunner read them. Keyed by the Ship object so parallel matches never
// see each other's hulls and a sunk hull is collected with its object.
const hullRates = new WeakMap<object, HullRates>();
export function recordHullRates(ship: object, rates: HullRates): void {
  const cur = hullRates.get(ship);
  if (cur) { cur.heaveRate = rates.heaveRate; cur.rollRate = rates.rollRate; cur.pitchRate = rates.pitchRate; }
  else hullRates.set(ship, { ...rates });
}
export function hullRatesOf(ship: object): HullRates | null {
  return hullRates.get(ship) ?? null;
}

type HullMotion = Pick<Ship, 'position' | 'rotation' | 'velocity' | 'angularVelocity'>;

/** World velocity of a point riding the hull: hull velocity + omega x r (yaw)
 *  + the heave / roll / pitch rates at that point's hull-local offset. */
export function hullPointVelocity(ship: HullMotion, point: Vec3, rates: HullRates | null = null): Vec3 {
  const offX = point.x - ship.position.x;
  const offZ = point.z - ship.position.z;
  const c = Math.cos(ship.rotation), s = Math.sin(ship.rotation);
  // world = pos + (lx c + lz s, lz c - lx s); d/d(rotation) of that = (offZ, -offX).
  const w = ship.angularVelocity || 0;
  let vy = 0;
  if (rates) {
    const lx = offX * c - offZ * s;
    const lz = offX * s + offZ * c;
    // Positive roll raises +x (y += lx sin roll); positive pitch dips the bow (y -= lz sin pitch).
    vy = rates.heaveRate + lx * rates.rollRate - lz * rates.pitchRate;
  }
  return {
    x: (ship.velocity.x || 0) + w * offZ,
    y: (ship.velocity.y || 0) + vy,
    z: (ship.velocity.z || 0) - w * offX,
  };
}

export function barrelDirection(yaw: number, pitch: number): Vec3 {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}

/** Launch velocity of a ball fired from `muzzle` along (yaw, pitch). */
export function cannonLaunchVelocity(
  ship: HullMotion, muzzle: Vec3, yaw: number, pitch: number,
  rates: HullRates | null = null, speed = CANNON_MUZZLE_SPEED,
): Vec3 {
  const d = barrelDirection(yaw, pitch);
  const u = hullPointVelocity(ship, muzzle, rates);
  return { x: d.x * speed + u.x, y: d.y * speed + u.y, z: d.z * speed + u.z };
}

/** World muzzle of gun `cannonIndex` laid at (yaw, pitch). */
export function cannonMuzzlePosition(
  ship: Pick<Ship, 'type' | 'position' | 'rotation'>, cannonIndex: number, yaw: number, pitch: number,
): Vec3 {
  const stats = SHIP_STATS[ship.type];
  const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
  const plusXSide = cannonIndex < cannonsPerSide; // +x = port (sideOfLocalX)
  // Muzzle x pokes outboard of the bulwark; the row z comes from the SHARED
  // stand-point math so the visual gun, prompt zone, mount snap and muzzle
  // always agree (the sloop's single gun per side sits amidships now).
  const localX = (plusXSide ? 1 : -1) * (stats.width * 0.5 + 0.08);
  const localZ = getCannonDeckLocalPosition(stats, cannonIndex).z;
  const baseX = ship.position.x + localX * Math.cos(ship.rotation) + localZ * Math.sin(ship.rotation);
  const baseY = ship.position.y + stats.height + 0.18;
  const baseZ = ship.position.z + localZ * Math.cos(ship.rotation) - localX * Math.sin(ship.rotation);
  return {
    x: baseX + Math.sin(yaw) * Math.cos(pitch) * 0.82,
    y: baseY + Math.sin(pitch) * 0.4,
    z: baseZ + Math.cos(yaw) * Math.cos(pitch) * 0.82,
  };
}

/** One exact SUVAT step, in place. */
export function stepBallistic(position: Vec3, velocity: Vec3, g: number, dt: number): void {
  position.x += velocity.x * dt;
  position.y += velocity.y * dt - 0.5 * g * dt * dt;
  position.z += velocity.z * dt;
  velocity.y -= g * dt;
}

/** Closed-form position `t` seconds after (position, velocity). */
export function ballisticPositionAt<T extends Vec3 = Vec3>(position: Vec3, velocity: Vec3, g: number, t: number, out: T = { x: 0, y: 0, z: 0 } as T): T {
  out.x = position.x + velocity.x * t;
  out.y = position.y + velocity.y * t - 0.5 * g * t * t;
  out.z = position.z + velocity.z * t;
  return out;
}

/**
 * Lay a gun at `muzzle` (moving at `carrier`, the inherited velocity) onto a
 * target at `target` moving at `targetVel`, muzzle speed `speed`, gravity `g`.
 * Solves |D + (targetVel - carrier) t + 1/2 g t^2 y| = speed t for the FIRST
 * (low-arc) flight time and returns the barrel yaw / pitch and that time, or
 * null when the target is out of reach.
 */
export function solveCannonAim(
  muzzle: Vec3, carrier: Vec3, target: Vec3, targetVel: Vec3,
  speed = CANNON_MUZZLE_SPEED, g = BALLISTIC_G,
): { yaw: number; pitch: number; flightTime: number } | null {
  const dx = target.x - muzzle.x, dy = target.y - muzzle.y, dz = target.z - muzzle.z;
  const wx = targetVel.x - carrier.x, wy = targetVel.y - carrier.y, wz = targetVel.z - carrier.z;
  const need = (t: number) => {
    const ax = dx + wx * t, ay = dy + wy * t + 0.5 * g * t * t, az = dz + wz * t;
    return { ax, ay, az, f: ax * ax + ay * ay + az * az - speed * speed * t * t };
  };
  // f > 0 at t -> 0 (the target is somewhere); the first sign change is the low arc.
  const tMax = 2 * speed / g + 4;
  const step = 0.02;
  let lo = 0, fLo = need(1e-6).f;
  let hi = -1;
  for (let t = step; t <= tMax; t += step) {
    const f = need(t).f;
    if (fLo > 0 && f <= 0) { hi = t; break; }
    lo = t; fLo = f;
  }
  if (hi < 0) return null;
  for (let i = 0; i < 40; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (need(mid).f > 0) lo = mid; else hi = mid;
  }
  const t = 0.5 * (lo + hi);
  const n = need(t);
  const inv = 1 / (speed * t);
  const mx = n.ax * inv, my = n.ay * inv, mz = n.az * inv;
  return { yaw: Math.atan2(mx, mz), pitch: Math.asin(Math.max(-1, Math.min(1, my))), flightTime: t };
}

/**
 * Grazing skip against the sea (physics-07), incidence measured against the
 * level sea. Returns true and reflects `velocity` in place when the ball skips;
 * false means it goes in (splash).
 */
export function trySkip(velocity: Vec3, skipsSoFar: number): boolean {
  if (skipsSoFar >= SKIP_MAX || velocity.y >= 0) return false;
  const h = Math.hypot(velocity.x, velocity.z);
  const speed = Math.hypot(h, velocity.y);
  if (speed <= SKIP_MIN_SPEED) return false;
  const incidence = Math.atan2(-velocity.y, h);
  if (incidence >= SKIP_MAX_INCIDENCE) return false;
  velocity.y = -SKIP_RESTITUTION * velocity.y;
  velocity.x *= SKIP_HORIZONTAL_KEEP;
  velocity.z *= SKIP_HORIZONTAL_KEEP;
  return true;
}
