/**
 * SAILING: ONE SOURCE FOR THE POINTS OF SAIL, THE YARD BRACE AND THE HULL.
 *
 * Read by the server physics (PhysicsSystem), the bot trimmer (BotPirate), the
 * first-sail assist (Match), the HUD trim meter (HudController) and the sail
 * renderer (ShipRenderer). Before this module each of them carried its own
 * copy of `sin(signedRelative) * MAX_SAIL_ANGLE * k` with k = 0.92 or 0.95, and
 * the renderer drew 0.6x of the simulated yard (physics-05). One function now,
 * so the Catch% the HUD shows is the catch the physics pays for.
 *
 * Conventions (PLAN 3.10): `signedRelative` = angleWrap(wind.direction -
 * ship.rotation) where wind.direction is where the wind blows TO, so 0 is a
 * dead run and +-PI is head to wind. `offWind` = PI - |signedRelative| (0 = head
 * to wind, PI = dead run). A positive brace swings the yard the same way as a
 * positive `ship.sailAngle` has always meant (lee yardarm aft; the sign is the
 * one the old formula had, only the magnitude curve changed).
 *
 * D16 class identity (PLAN section 2): top speeds sloop 14.0 on the beam,
 * brigantine 13.5 on the broad reach, galleon 13.0 broad reach to dead run; the
 * sloop points highest (usable from 40 deg) and keeps the BR ladder at the
 * beam; mass 1 : 1.9 : 3.6. Pure math, no RNG, no state: server and client
 * evaluate it bit-identically.
 */
import { SHIP, SHIP_STATS } from './constants/index.js';
import type { ShipType } from './types/index.js';

const DEG = Math.PI / 180;

// ── Yard brace (physics-05) ──────────────────────────────────────────────────

/** Square-rig brace limit: 65 deg. The old 0.48 PI (86 deg) had the yard lying
 *  fore-and-aft, which no square rig can do (the shrouds stop it near 60-65). */
export const MAX_BRACE = 65 * DEG;

/**
 * The ideal yard brace for the wind on this heading, in radians, signed.
 * The yard bisects the angle between the keel and the wind: 0 on a dead run,
 * 22.5 deg on the broad reach (135 off), 45 deg on the beam, capped at 65 deg
 * from 50 deg off the wind upward (close-hauled and in irons hold the cap).
 * Monotonic in the angle off the wind, so bracing up as you point higher is
 * always right; the old curve peaked at the beam and fell again.
 */
export function idealBrace(signedRelative: number): number {
  const a = Math.abs(signedRelative);
  if (!Number.isFinite(a) || a === 0) return 0;
  const mag = Math.min(MAX_BRACE, Math.min(a, Math.PI) * 0.5);
  return signedRelative > 0 ? mag : -mag;
}

function wrap(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  else if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Brace error as a fraction of the brace range: 0 = yard exactly right,
 *  1 = a full MAX_BRACE (or more) off. */
export function braceError(sailAngle: number, signedRelative: number): number {
  return Math.min(1, Math.abs(wrap(sailAngle - idealBrace(signedRelative))) / MAX_BRACE);
}

/** How much of the wind the yard holds, 0..1 (the HUD's Catch%, the sail
 *  billow). The physics pays 1 - braceError^1.15 of it (trimEfficiency). */
export function braceCatch(sailAngle: number, signedRelative: number): number {
  return 1 - braceError(sailAngle, signedRelative);
}

/** Thrust share the physics pays for a given brace error (unchanged curve). */
export function trimEfficiency(sailAngle: number, signedRelative: number): number {
  return 1 - Math.pow(braceError(sailAngle, signedRelative), 1.15);
}

// ── Per-class polars (physics-03, D16) ───────────────────────────────────────

/** Knots are [deg off the wind, m/s at full canvas, ideal brace, wind 1.0].
 *  Inside the no-go cone (SHIP.SAIL_NO_GO_ANGLE, ~35 deg) the canvas luffs to a
 *  drift <= 1.5 m/s. Linear between knots; flat past the ends. */
export const SAIL_POLARS: Readonly<Record<ShipType, ReadonlyArray<readonly [number, number]>>> = {
  //            irons      cone edge  sloop points high               beam peak     broad       run
  sloop:      [[0, 1.4], [35, 1.4], [40, 4.5], [45, 6.5], [60, 10.0], [90, 14.0], [135, 13.0], [180, 11.0]],
  brigantine: [[0, 1.35], [35, 1.35], [40, 2.2], [45, 5.5], [60, 8.5], [90, 12.5], [135, 13.5], [180, 12.5]],
  galleon:    [[0, 1.3], [35, 1.3], [40, 1.6], [45, 4.0], [60, 7.0], [90, 11.5], [135, 13.0], [180, 13.0]],
};

/** The D16 top speed of each class (the max over its polar). */
export const CLASS_TOP_SPEED: Readonly<Record<ShipType, number>> = {
  sloop: 14.0,
  brigantine: 13.5,
  galleon: 13.0,
};

/** Rated boat speed (m/s) on this point of sail with full canvas, ideal brace
 *  and a wind of strength 1.0. `offWind` in radians, 0 = head to wind. */
export function polarSpeed(type: ShipType, offWind: number): number {
  const knots = SAIL_POLARS[type] ?? SAIL_POLARS.sloop;
  const raw = Number.isFinite(offWind) ? Math.abs(offWind) : 0;
  const deg = Math.min(180, raw) / DEG;
  // The cone edge follows the shared no-go constant exactly, so `luffing`
  // (PhysicsSystem) and the polar floor switch at the same angle.
  if (raw <= SHIP.SAIL_NO_GO_ANGLE) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [d1, v1] = knots[i];
    if (deg <= d1) {
      const [d0, v0] = knots[i - 1];
      const t = d1 > d0 ? (deg - d0) / (d1 - d0) : 1;
      return v0 + (v1 - v0) * Math.min(1, Math.max(0, t));
    }
  }
  return knots[knots.length - 1][1];
}

/** The polar as a share of the class top speed (0..1). */
export function sailPolarFraction(type: ShipType, offWind: number): number {
  return polarSpeed(type, offWind) / CLASS_TOP_SPEED[type];
}

// ── Hull parameters (mass, drag, keel, yaw inertia) ──────────────────────────

/** Sloop displacement (kg); the ladder scales it 1 : 1.9 : 3.6. */
export const SLOOP_MASS = 24_000;
export const CLASS_MASS_RATIO: Readonly<Record<ShipType, number>> = {
  sloop: 1,
  brigantine: 1.9,
  galleon: 3.6,
};
/** D16/3.7 design targets the drag is solved for: time to 90% of top speed from
 *  rest with canvas set (sloop 7-9, brig 10-12, galleon 14-17 s). */
export const CLASS_T90: Readonly<Record<ShipType, number>> = {
  sloop: 8.0,
  brigantine: 11.0,
  galleon: 14.5,
};
/** Share of the hull resistance at top speed that is quadratic (wave-making);
 *  the rest is linear skin friction. Coast-down to < 1 m/s is ~1.15x t90 for
 *  pure linear drag and grows with this share (0.12 put the galleon at 18.8 s),
 *  so it stays small to land the D16 coast-down windows (sloop 6-12 s, galleon
 *  10-18 s: 9.9 / 13.4 / 17.4 s analytic). */
export const QUADRATIC_SHARE = 0.06;
/** Lateral (keel) resistance per unit forward resistance: c_lat >= 25 c (3.7). */
export const KEEL_LATERAL_RATIO = 25;

export interface HullParams {
  type: ShipType;
  /** kg */
  mass: number;
  /** m/s: the class top speed the drag balances at full drive. */
  topSpeed: number;
  /** N/(m/s): linear hull drag. */
  c1: number;
  /** N/(m/s)^2: quadratic hull drag, F = c2 v|v|. */
  c2: number;
  /** N: full-canvas drive at the class's best point of sail (= drag at topSpeed). */
  maxDrive: number;
  /** Lateral (keel) drag, linear and quadratic. */
  cLat1: number;
  cLat2: number;
  /** kg m^2: yaw inertia m (L^2 + B^2) / 12. */
  yawInertia: number;
  /** Design numbers the drag was solved for (s), analytic. */
  t90: number;
  coastToOne: number;
}

const ATANH_09 = 0.5 * Math.log(1.9 / 0.1);

/** Analytic time from rest to 0.9 vT under dv/dt = a (vT - v) + b (vT^2 - v^2),
 *  i.e. constant drive balanced by linear (a) + quadratic (b) drag at vT. */
export function analyticT90(a: number, b: number, vT: number): number {
  if (b <= 1e-12) return Math.log(10) / a;
  if (a <= 1e-12) return ATANH_09 / (b * vT);
  const r = vT + a / b;
  return Math.log((10 * (0.9 * vT + r)) / r) / (b * (vT + r));
}

/** Analytic coast-down time from v0 to v1 with no drive. */
export function analyticCoast(a: number, b: number, v0: number, v1: number): number {
  if (b <= 1e-12) return Math.log(v0 / v1) / a;
  if (a <= 1e-12) return (1 / v1 - 1 / v0) / b;
  return Math.log((v0 * (a + b * v1)) / (v1 * (a + b * v0))) / a;
}

function solveHull(type: ShipType): HullParams {
  const stats = SHIP_STATS[type];
  const mass = SLOOP_MASS * CLASS_MASS_RATIO[type];
  const vT = CLASS_TOP_SPEED[type];
  const t90 = CLASS_T90[type];
  // Resistance at vT is R = m (a vT + b vT^2) with b vT^2 = q R. Scale s = a:
  // b = q a / ((1 - q) vT). t90 falls monotonically in s: bisect (fixed 64
  // steps, deterministic, identical on server and client).
  const q = QUADRATIC_SHARE;
  let lo = 1e-4;
  let hi = 10;
  for (let i = 0; i < 64; i++) {
    const mid = 0.5 * (lo + hi);
    const tm = analyticT90(mid, (q * mid) / ((1 - q) * vT), vT);
    if (tm > t90) lo = mid; else hi = mid;
  }
  const a = 0.5 * (lo + hi);
  const b = (q * a) / ((1 - q) * vT);
  const c1 = a * mass;
  const c2 = b * mass;
  return {
    type,
    mass,
    topSpeed: vT,
    c1,
    c2,
    maxDrive: c1 * vT + c2 * vT * vT,
    cLat1: c1 * KEEL_LATERAL_RATIO,
    cLat2: c2 * KEEL_LATERAL_RATIO,
    yawInertia: (mass * (stats.length ** 2 + stats.width ** 2)) / 12,
    t90: analyticT90(a, b, vT),
    coastToOne: analyticCoast(a, b, vT, 1),
  };
}

export const HULL_PARAMS: Readonly<Record<ShipType, HullParams>> = {
  sloop: solveHull('sloop'),
  brigantine: solveHull('brigantine'),
  galleon: solveHull('galleon'),
};
