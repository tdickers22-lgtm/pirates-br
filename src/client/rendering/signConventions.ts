// THE SIGNS THAT WERE BACKWARDS (b1.6a) — one pure module, so the
// no-inversion gate (scripts/test-anim-no-inversion.mjs) grades the exact
// numbers the renderers draw with, in node, in milliseconds.
//
// Conventions everything below is derived from (and the gate re-derives):
//   * A ship's forward is (sin r, cos r); `ship.rotation` = r. +rudder gives
//     omega < 0 (PhysicsSystem.applyShipRudderSteering), which is a turn to the
//     helmsman's RIGHT (he stands aft facing +Z, his right is local -X).
//   * `wind.direction` is the yaw the wind blows TOWARD (sampleLocalWind), so
//     the wind-to vector is (sin d, cos d) and a hull whose rotation equals d
//     is on a dead run.
//   * Look pitch is + for UP (InputManager pitch -= dy; Game forward.y =
//     sin(pitch)). Both the rigged head bone and the low-tier procedural head
//     face +Z, and +rotation.x about X turns +Z toward -Y (DOWN).

/** Three quarter-turns lock to lock (ships-12). */
export const WHEEL_TURNS_LOCK_TO_LOCK = 0.75;

/**
 * Wheel rotation.z for a rudder at `rudder01` (-1..1, + = steer right). The
 * wheel's axis runs fore-aft and the helmsman looks forward along it, so +z
 * carries the TOP spoke toward local -X, his right: the peg goes the way the
 * bow goes (animations-05; it used to be negated).
 */
export function helmWheelRotZ(rudder01: number): number {
  return rudder01 * WHEEL_TURNS_LOCK_TO_LOCK * Math.PI;
}

/** True wind speed in m/s per unit of `wind.strength` (0.78..0.98 calm, more
 *  in the storm gale). Chosen so the fastest hull (15.5 m/s) on a dead run
 *  nearly cancels a calm breeze: the flag goes slack on a fast run, which is
 *  what a real masthead flag does, and never streams forward in clear weather. */
export const TRUE_WIND_MS_PER_STRENGTH = 17;

export type ApparentWind = { localYaw: number; speed: number };

/**
 * The wind a flag on this hull FEELS: true wind minus the hull's own velocity,
 * as a yaw in the ship's frame (the direction it blows TOWARD) and a speed.
 */
export function apparentWindLocal(
  windDirection: number,
  windStrength: number,
  shipRotation: number,
  vx: number,
  vz: number,
  out: ApparentWind = { localYaw: 0, speed: 0 },
): ApparentWind {
  const w = windStrength * TRUE_WIND_MS_PER_STRENGTH;
  const ax = Math.sin(windDirection) * w - vx;
  const az = Math.cos(windDirection) * w - vz;
  out.speed = Math.hypot(ax, az);
  const worldYaw = out.speed > 1e-6 ? Math.atan2(ax, az) : windDirection;
  out.localYaw = wrap(worldYaw - shipRotation);
  return out;
}

/**
 * Pivot rotation.y that points a flag/pennant built along its local +X
 * DOWNWIND of `localYaw` (animations-06: it was PI/2 + yaw, which is exactly
 * upwind). Ry(t) maps +X to (cos t, -sin t); t = yaw - PI/2 gives (sin, cos).
 */
export function flagPivotYaw(localYaw: number): number {
  return wrap(localYaw - Math.PI * 0.5);
}

/** 0 = streaming, 1 = hanging off the halyard. Full fly above 5 m/s of
 *  apparent wind; slack below 1 m/s (a run at the wind's own speed). */
export function flagSlack(apparentSpeed: number): number {
  const t = Math.min(1, Math.max(0, (apparentSpeed - 1) / 4));
  return 1 - t * t * (3 - 2 * t);
}

/** Max droop of a slack flag (rad about the pivot's local Z; negative z drops
 *  the fly end, since Rz(t) maps +X to (cos t, sin t)). */
export const FLAG_MAX_DROOP = 1.2;

/**
 * Foliage sway uniform (world x, z) for the wind at the camera
 * (animations-11: it was a fixed (0.68, 0.46) whatever the wind did). The
 * magnitude keeps the old calm-weather lean (|(0.68, 0.46)| = 0.82 at
 * strength 0.9) and scales with the local strength, so the storm gale bends
 * the palms harder.
 */
export function foliageWindInto(
  out: { set(x: number, y: number): unknown },
  windDirection: number,
  windStrength: number,
  gust: number,
): void {
  const mag = 0.82 * gust * Math.min(2, Math.max(0, windStrength) / 0.9);
  out.set(Math.sin(windDirection) * mag, Math.cos(windDirection) * mag);
}

/** Bone/pivot rotation.x that raises a +Z-facing head (or a raised arm) by a
 *  look pitch that is + for UP (animations-08, vm:animations:1). */
export function pitchUpToBoneX(pitchUp: number): number {
  return -pitchUp;
}

/** Low-tier procedural head: 70% of the look pitch in the neck, and a neck
 *  looks further up (0.6) than down (0.5). */
export function lowTierHeadPitchX(lookPitchUp: number): number {
  return Math.min(0.5, Math.max(-0.6, pitchUpToBoneX(lookPitchUp * 0.7)));
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
