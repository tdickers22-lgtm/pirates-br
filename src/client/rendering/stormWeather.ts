/**
 * THE WEATHER, AS A FUNCTION OF WHERE YOU ARE LOOKING FROM.
 *
 * These four functions were three methods on EnvironmentFx that each reached
 * for a different position: the overcast and the rain read the local PLAYER,
 * the wall-nearness term read the CAMERA. One storm, two anchors — so a
 * spectator watching the last hull from the ring centre stood in the downpour
 * of a body 300 m outside the ring (storm-14), and the endgame, the one moment
 * the camera is not on the player, was the moment the weather lied.
 *
 * Pulled out here because they are pure: distance in, 0..1 out. The renderer
 * calls them with ONE anchor (Game.getWeatherAnchor: the camera whenever the
 * camera has left the body — spectate, free cam — the player otherwise), and
 * `scripts/test-storm-visuals.mjs` calls them with two and grades that the
 * answers differ. No three.js import, so the suite costs nothing to run.
 */

export type StormRingLike = {
  centerX: number;
  centerZ: number;
  safeRadius: number;
  phase: number;
  shrinking: boolean;
  shrinkProgress: number;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** three's MathUtils.smoothstep argument order, without the import. */
const smoothstep = (x: number, min: number, max: number) => {
  if (max <= min) return x < min ? 0 : 1;
  const t = clamp01((x - min) / (max - min));
  return t * t * (3 - 2 * t);
};
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** 0 = far from the storm boundary, 1 = at it. Shared by the rain and the
 *  overcast so a squall's water and its cloud arrive on the same ramp.
 *  `wallDist` is the unsigned distance from the ANCHOR to the ring wall
 *  (negative means "no ring"). */
export function stormWallNearness01(wallDist: number): number {
  if (!Number.isFinite(wallDist) || wallDist < 0) return 0;
  return 1 - smoothstep(wallDist, 30, 165);
}

/**
 * The overcast: how much storm sky is over the anchor. Inside the ring this
 * stays under 0.24 except at the very edge; outside it ramps to 1 over ~240 m.
 *
 * A SHOWER CARRIES ITS OWN SKY: the wall-nearness term reaches inboard a little
 * ahead of the rain, so drops never fall out of a cloudless noon blue.
 */
export function stormWeatherIntensityAt(
  x: number,
  z: number,
  storm: StormRingLike,
  maxPhase: number,
  wallNearness: number,
): number {
  const safeRadius = Math.max(1, storm.safeRadius);
  const phases = Math.max(1, maxPhase);
  const dist = Math.hypot(x - storm.centerX, z - storm.centerZ);
  const phaseBoost = Math.min(1, storm.phase / phases) * 0.2;
  const shrinkBoost = storm.shrinking ? 0.08 + storm.shrinkProgress * 0.08 : 0;

  // Crossfade across a ±30 m band at the wall — weather used to snap from 0.24
  // to 0.52+ the frame you crossed the boundary.
  const distOutside = dist - safeRadius;
  const outsideBlend = smoothstep(distOutside, -30, 30);
  const stormDepth = clamp01(distOutside / 240);
  const edgeFade = clamp01((dist / safeRadius - 0.84) / 0.16);
  const insideIntensity = Math.min(0.24, edgeFade * 0.14 + shrinkBoost * 0.45);
  const outsideIntensity = Math.min(1, 0.52 + phaseBoost + shrinkBoost + stormDepth * 0.32);
  const base = insideIntensity + (outsideIntensity - insideIntensity) * outsideBlend;

  const wallOvercast = clamp01(wallNearness) * (0.34 + (storm.phase / phases) * 0.14);
  return clamp01(finite(Math.max(base, wallOvercast)));
}

/**
 * The drops. Same shape as the overcast, on a slightly later ramp, and hard
 * capped by the sky above: rain may never outrun the cloud producing it.
 */
export function stormRainIntensityAt(
  x: number,
  z: number,
  storm: StormRingLike,
  maxPhase: number,
  wallNearness: number,
): number {
  const safeRadius = Math.max(1, storm.safeRadius);
  const phases = Math.max(1, maxPhase);
  const dist = Math.hypot(x - storm.centerX, z - storm.centerZ);
  const distOutside = dist - safeRadius;
  const outsideBlend = smoothstep(distOutside, -25, 35);
  const stormDepth = clamp01(distOutside / 220);
  const shrinkBoost = storm.shrinking ? 0.08 : 0;
  const fromAnchor = outsideBlend <= 0.001
    ? 0
    : Math.min(1, 0.34 + stormDepth * 0.42 + (storm.phase / phases) * 0.2 + shrinkBoost) * outsideBlend;

  const wallFloor = clamp01(wallNearness) * (0.30 + (storm.phase / phases) * 0.16);
  const wanted = Math.max(fromAnchor, wallFloor);

  const skyCap = Math.min(1, stormWeatherIntensityAt(x, z, storm, maxPhase, wallNearness) * 1.3);
  return clamp01(finite(Math.min(wanted, skyCap)));
}
