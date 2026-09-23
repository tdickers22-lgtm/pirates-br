/**
 * AIM ASSIST (b1.4h; D13, crossdevice target spec section 3).
 *
 * Touch and gamepad only. A mouse or a Mac trackpad never gets any of it: the
 * scheme tracker calls both 'mouse', and that is the first thing checked.
 *
 *  - Slowdown: while the crosshair ray passes within 2.5 deg (x fovScale) of an
 *    enemy hitbox that is <= 60 m away and in line of sight, the look rate from
 *    the stick or the finger is multiplied by 0.55. It never turns the view by
 *    itself.
 *  - Magnetism: only while Aim is held, the view drifts toward the nearest such
 *    target inside a 4 deg cone at <= 3 deg/s. A step is bounded by that rate
 *    times a dt clamped to 50 ms and never overshoots, so it cannot snap.
 *  - Never at a cannon or the helm, never with the Wrecker's Glass (D19) or the
 *    spyglass up, never through cover (the caller's line-of-sight test).
 *
 * Client-only: it only nudges the yaw/pitch the client already sends. The
 * functions below are pure (no DOM, no three.js) and are what test-aim-assist
 * runs; InputManager keeps the per-frame state, Game supplies the frame.
 */
import type { GameState, Player, Vec3, WeaponId } from '../../shared/types/index.js';
import { intersectRayShipHull, raymarchIslandSurface } from '../../shared/raycast.js';

export const AIM_ASSIST = {
  /** Look rate multiplier inside the slowdown cone. */
  slowdown: 0.55,
  /** Slowdown cone half-angle at the base FOV (scaled by fovScale). */
  slowdownConeDeg: 2.5,
  /** Magnetism cone half-angle at the base FOV (scaled by fovScale). */
  magnetConeDeg: 4,
  /** Magnetism ceiling, degrees of view per second. */
  magnetRateDegPerSec: 3,
  /** Nothing further than this is assisted. */
  maxRangeM: 60,
  /** A frame longer than this is treated as this long: a hitch never becomes a snap. */
  maxDtSec: 0.05,
} as const;

const DEG = Math.PI / 180;
const PITCH_LIMIT = Math.PI * 0.45;

export type AimScheme = 'mouse' | 'gamepad' | 'touch';
export type AimContext = 'foot' | 'helm' | 'cannon' | 'swim';

/** A hitbox: its centre and radius (m). */
export type AimTarget = { readonly x: number; readonly y: number; readonly z: number; readonly radius: number };

export type AimAssistFrame = {
  scheme: AimScheme;
  /** The Controls setting (on by default). */
  enabled: boolean;
  context: AimContext | null;
  /** Weapon in hand (null = none / a tool). */
  weaponId: WeaponId | null;
  /** Spyglass raised: optics are never assisted. */
  scoped: boolean;
  /** Camera position the crosshair ray starts from. */
  eye: Vec3;
  /** Candidate enemies (players and creatures), already filtered for friend/foe and alive. */
  targets: readonly AimTarget[];
  /** Line of sight from the eye to a point: false when terrain or a hull is in the way. */
  los: (from: Vec3, to: Vec3) => boolean;
  /** currentFov / baseFov (<= 1 when zoomed). */
  fovScale: number;
};

/** Weapons that never get assist: the Wrecker's Glass (D19) and the ship's gun. */
const NEVER_ASSISTED: ReadonlySet<WeaponId> = new Set<WeaponId>(['eye_of_reach', 'ship_cannon']);

/** May this frame be assisted at all? */
export function aimAssistAllowed(f: Pick<AimAssistFrame, 'scheme' | 'enabled' | 'context' | 'weaponId' | 'scoped'>): boolean {
  if (f.scheme === 'mouse') return false;
  if (!f.enabled) return false;
  if (f.context !== 'foot' && f.context !== 'swim') return false;
  if (f.scoped) return false;
  if (f.weaponId !== null && NEVER_ASSISTED.has(f.weaponId)) return false;
  return true;
}

/** Unit view vector for (yaw, pitch), the same convention as Game.getLookDirection. */
export function lookVector(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
}

function wrapPi(a: number): number {
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r - Math.PI;
}

export type AimPick = {
  target: AimTarget;
  /** Angle from the crosshair ray to the hitbox EDGE (0 when the ray is inside it). */
  edgeAngle: number;
  /** Yaw and pitch that put the crosshair on the hitbox centre. */
  yaw: number;
  pitch: number;
  distance: number;
};

/**
 * The target nearest the crosshair whose hitbox edge lies inside `coneRad`,
 * within range and in line of sight (LOS is only asked for candidates already
 * inside the cone, so a frame costs at most a few raycasts).
 */
export function pickAimTarget(f: AimAssistFrame, yaw: number, pitch: number, coneRad: number): AimPick | null {
  const v = lookVector(yaw, pitch);
  const cands: AimPick[] = [];
  for (const t of f.targets) {
    const dx = t.x - f.eye.x;
    const dy = t.y - f.eye.y;
    const dz = t.z - f.eye.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 1e-3) || d > AIM_ASSIST.maxRangeM) continue;
    const cos = Math.max(-1, Math.min(1, (dx * v.x + dy * v.y + dz * v.z) / d));
    const centre = Math.acos(cos);
    const edgeAngle = Math.max(0, centre - Math.atan2(Math.max(0, t.radius), d));
    if (edgeAngle > coneRad) continue;
    cands.push({ target: t, edgeAngle, yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), distance: d });
  }
  cands.sort((a, b) => a.edgeAngle - b.edgeAngle || a.distance - b.distance);
  for (const c of cands) if (f.los(f.eye, c.target)) return c;
  return null;
}

/** Look-rate multiplier for this frame: 0.55 on an assisted target, else 1. */
export function lookSlowdown(f: AimAssistFrame, yaw: number, pitch: number): number {
  if (!aimAssistAllowed(f)) return 1;
  const cone = AIM_ASSIST.slowdownConeDeg * DEG * Math.max(0.05, Math.min(1, f.fovScale));
  return pickAimTarget(f, yaw, pitch, cone) ? AIM_ASSIST.slowdown : 1;
}

/**
 * Magnetism for one frame: the yaw/pitch change (radians) toward the nearest
 * assisted target inside the 4 deg cone. Zero unless aiming. |dYaw| and |dPitch|
 * are each <= 3 deg/s x min(dt, 50 ms), and the step never passes the target.
 */
export function magnetismStep(f: AimAssistFrame, yaw: number, pitch: number, aiming: boolean, dtSec: number): { dYaw: number; dPitch: number } {
  const none = { dYaw: 0, dPitch: 0 };
  if (!aiming || !aimAssistAllowed(f)) return none;
  const dt = Math.min(AIM_ASSIST.maxDtSec, Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0);
  if (dt <= 0) return none;
  const cone = AIM_ASSIST.magnetConeDeg * DEG * Math.max(0.05, Math.min(1, f.fovScale));
  const pick = pickAimTarget(f, yaw, pitch, cone);
  if (!pick) return none;
  const eYaw = wrapPi(pick.yaw - yaw);
  const ePitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pick.pitch)) - pitch;
  const err = Math.hypot(eYaw, ePitch);
  if (err < 1e-6) return none;
  const step = Math.min(err, AIM_ASSIST.magnetRateDegPerSec * DEG * dt);
  return { dYaw: (eYaw / err) * step, dPitch: (ePitch / err) * step };
}

/** Player hitbox for the cone test: chest height above the feet, torso radius. */
const PLAYER_CENTRE_Y = 1.0;
const PLAYER_RADIUS = 0.45;
const SHARK_RADIUS = 0.9;
const LIVE_STATES: ReadonlySet<Player['state']> = new Set<Player['state']>(['alive', 'swimming', 'boarding']);

/** Enemy hitboxes for the local player: other crews' standing pirates and live sharks. */
export function collectAimTargets(state: Pick<GameState, 'players' | 'sharks'>, me: Pick<Player, 'id' | 'crewId' | 'position'>): AimTarget[] {
  const out: AimTarget[] = [];
  const r2 = (AIM_ASSIST.maxRangeM + 5) ** 2;
  const near = (p: Vec3) => (p.x - me.position.x) ** 2 + (p.z - me.position.z) ** 2 <= r2;
  for (const p of state.players) {
    if (p.id === me.id || !LIVE_STATES.has(p.state)) continue;
    if (me.crewId !== null && p.crewId === me.crewId) continue;
    if (!near(p.position)) continue;
    out.push({ x: p.position.x, y: p.position.y + PLAYER_CENTRE_Y, z: p.position.z, radius: PLAYER_RADIUS });
  }
  for (const s of state.sharks ?? []) {
    if (s.health <= 0 || s.despawnTimer !== undefined || !near(s.position)) continue;
    out.push({ x: s.position.x, y: s.position.y, z: s.position.z, radius: SHARK_RADIUS });
  }
  return out;
}

/**
 * Cover test on the same shared truth the server shoots through: island terrain
 * (raymarchIslandSurface) and hull prisms (intersectRayShipHull). Hulls within
 * 1 m of either end are skipped so a target on a deck is not hidden by its own
 * rail and the shooter's own bulwark does not block her.
 */
export function makeAimLineOfSight(state: Pick<GameState, 'islands' | 'ships'>): (from: Vec3, to: Vec3) => boolean {
  return (from, to) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 1e-3)) return true;
    const dir = { x: dx / d, y: dy / d, z: dz / d };
    if (raymarchIslandSurface(from, dir, d, state.islands).hit) return false;
    for (const ship of state.ships) {
      const at = intersectRayShipHull(from, dir, d, ship);
      if (at !== null && at > 1 && at < d - 1) return false;
    }
    return true;
  };
}
