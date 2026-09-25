/**
 * Spatial audio model (b2.4c; audio-04, audio-10, audio-15).
 *
 * Pure math plus two small Web Audio factories, so the laws are testable without a browser:
 *   - per-category distance gain (inverse law, ref / max / rolloff per category), monotonic
 *     non-increasing in distance;
 *   - continuous air absorption (a distance lowpass whose cutoff falls like sqrt(1/d), the shape
 *     of real high-frequency absorption; no steps);
 *   - speed of sound: d/343 for every positioned one-shot beyond 30 m, no cap and no 140 m switch
 *     (below 30 m the delay blends in from 0 so a footstep beside you is not late);
 *   - the cannon crack layer crossfades out over 120-220 m (the body keeps going, the far thump
 *     takes over), instead of a hard timbre switch;
 *   - Doppler as a playback-rate ratio, and the ratio curve for a straight cannonball fly-by;
 *   - PannerNode (HRTF on high-tier desktop, equalpower elsewhere) positioned in world space and
 *     an AudioListener that follows the camera, so a source behind you stays behind you when you
 *     turn, and an equalpower source behind gets a head-shadow darkening (equalpower alone cannot
 *     tell front from back).
 *
 * thunderArrivalDelay (SoundEngine) keeps its own model on purpose (storm-21 do-not-regress).
 */

export const SPEED_OF_SOUND = 343;
/** Positioned one-shots beyond this distance arrive d/343 late (below it the delay blends in). */
export const DELAY_ONSET_M = 30;
/** Cannon crack crossfade band (metres): full crack inside, none beyond. */
export const CRACK_FADE_START_M = 120;
export const CRACK_FADE_END_M = 220;

export type SpatialCategory =
  | 'footstep' | 'foley' | 'melee' | 'creature' | 'default' | 'gun' | 'splash' | 'impact' | 'cannon' | 'explosion';

export interface DistanceCurve {
  /** Distance (m) inside which the gain is 1. */
  ref: number;
  /** Beyond this the gain stops falling (the sound is then culled by its caller or the allocator). */
  max: number;
  /** Inverse-law rolloff: gain = ref / (ref + rolloff * (d - ref)); -6 dB at ref + ref / rolloff. */
  rolloff: number;
}

/**
 * Per-category curves. 'default' reproduces the pre-b2.4c law 1/(1+d/24) within 1 dB so the mix of
 * everything not re-categorised is unchanged; the loud families carry further (a broadside is a
 * range cue at 600 m) and the quiet ones die sooner (a boarder's footsteps are a 10-20 m cue).
 * -6 dB distance in the comments.
 */
export const SPATIAL_CATEGORIES: Readonly<Record<SpatialCategory, DistanceCurve>> = {
  footstep: { ref: 1, max: 60, rolloff: 0.08 }, //   13.5 m
  foley: { ref: 1, max: 80, rolloff: 0.08 }, //      13.5 m
  melee: { ref: 1.5, max: 120, rolloff: 0.08 }, //   20 m
  creature: { ref: 2, max: 200, rolloff: 2 / 24 }, // 26 m
  default: { ref: 2, max: 400, rolloff: 2 / 24 }, //  26 m (old law)
  gun: { ref: 3, max: 600, rolloff: 0.1 }, //         33 m
  splash: { ref: 2, max: 400, rolloff: 2 / 28 }, //   30 m
  impact: { ref: 3, max: 600, rolloff: 0.08 }, //    40.5 m
  cannon: { ref: 6, max: 1500, rolloff: 0.1 }, //     66 m
  explosion: { ref: 6, max: 1500, rolloff: 0.1 }, //  66 m
};

export function isSpatialCategory(c: unknown): c is SpatialCategory {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(SPATIAL_CATEGORIES, c);
}

function finiteNonNeg(d: number): number {
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Distance gain 0..1 for a category (inverse law, clamped to [ref, max]). */
export function gainFor(category: SpatialCategory, distanceM: number): number {
  const c = SPATIAL_CATEGORIES[isSpatialCategory(category) ? category : 'default'];
  const d = Math.min(Math.max(finiteNonNeg(distanceM), c.ref), c.max);
  return c.ref / (c.ref + c.rolloff * (d - c.ref));
}

/**
 * Air-absorption lowpass cutoff (Hz). Real absorption grows roughly with f^2, so the -3 dB
 * frequency falls like 1/sqrt(d): ~8 kHz at 30 m, ~4 kHz at 120 m, ~2 kHz at 480 m. Continuous
 * and monotonic; 20 kHz inside ~5 m, floor 500 Hz.
 */
export function airCutoffFor(distanceM: number): number {
  const d = Math.max(1, finiteNonNeg(distanceM));
  return Math.min(20000, Math.max(500, 8000 * Math.sqrt(DELAY_ONSET_M / d)));
}

/**
 * Sound travel time (s). d/343 beyond 30 m (no cap). Inside 30 m it blends in as
 * (d/343) * (d/30): continuous at 30 m, under 10 ms inside 10 m, so near sounds stay in sync with
 * what you see.
 */
export function delayFor(distanceM: number): number {
  const d = finiteNonNeg(distanceM);
  if (d >= DELAY_ONSET_M) return d / SPEED_OF_SOUND;
  return (d / SPEED_OF_SOUND) * (d / DELAY_ONSET_M);
}

/** Cannon crack-layer weight: 1 inside 120 m, smoothstep to 0 at 220 m. */
export function crackMix(distanceM: number): number {
  const d = finiteNonNeg(distanceM);
  const t = Math.min(1, Math.max(0, (d - CRACK_FADE_START_M) / (CRACK_FADE_END_M - CRACK_FADE_START_M)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Doppler frequency ratio (= playbackRate multiplier) for a source moving toward the listener at
 * `sourceToward` m/s and a listener moving toward the source at `listenerToward` m/s (negative =
 * receding). Clamped so a supersonic input cannot divide by zero.
 */
export function dopplerRatio(sourceToward: number, listenerToward = 0): number {
  const vs = Number.isFinite(sourceToward) ? Math.max(-0.9 * SPEED_OF_SOUND, Math.min(0.9 * SPEED_OF_SOUND, sourceToward)) : 0;
  const vl = Number.isFinite(listenerToward) ? Math.max(-0.9 * SPEED_OF_SOUND, Math.min(0.9 * SPEED_OF_SOUND, listenerToward)) : 0;
  return (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND - vs);
}

/**
 * Doppler ratio curve for a straight fly-by: speed `speed` m/s, miss distance `miss` m, closest
 * approach `closestAt` seconds into a `duration`-second window, `steps` samples. Radial speed
 * toward the listener at time t (relative to closest approach) is -v^2 t / sqrt(b^2 + v^2 t^2).
 */
export function flybyDopplerCurve(miss: number, speed: number, duration: number, closestAt: number, steps = 32): Float32Array {
  const b = Math.max(0.5, finiteNonNeg(miss));
  const v = finiteNonNeg(speed);
  const n = Math.max(2, Math.min(256, Math.floor(steps)));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * finiteNonNeg(duration) - finiteNonNeg(closestAt);
    const r = Math.hypot(b, v * t);
    out[i] = dopplerRatio((-v * v * t) / r);
  }
  return out;
}

export interface Vec3Like { x: number; y: number; z: number }

/**
 * Where a source sits relative to the listener (yaw-only basis, forward = the look direction
 * flattened, three.js right = forward x up). azimuth: 0 ahead, +90 right, +-180 behind.
 */
export function listenerRelative(listener: Vec3Like, forward: Vec3Like, pos: Vec3Like): { azimuthDeg: number; cosFront: number; pan: number } {
  const fl = Math.hypot(forward.x, forward.z);
  const fx = fl > 1e-6 ? forward.x / fl : 0;
  const fz = fl > 1e-6 ? forward.z / fl : -1;
  const dx = pos.x - listener.x;
  const dz = pos.z - listener.z;
  const len = Math.hypot(dx, dz);
  if (!(len >= 0.5)) return { azimuthDeg: 0, cosFront: 1, pan: 0 };
  const front = (dx * fx + dz * fz) / len;
  const right = (dx * -fz + dz * fx) / len;
  return { azimuthDeg: (Math.atan2(right, front) * 180) / Math.PI, cosFront: front, pan: right };
}

/**
 * Head-shadow cue for the equalpower path (HRTF encodes front/back itself): a source behind is
 * darker and slightly quieter. cosFront 1 -> no change, -1 -> cutoff x0.55, gain x0.85 (-1.4 dB).
 */
export function rearShade(cosFront: number): { cutoffMul: number; gainMul: number } {
  const behind = Number.isFinite(cosFront) ? Math.max(0, -cosFront) : 0;
  return { cutoffMul: 1 - 0.45 * behind, gainMul: 1 - 0.15 * behind };
}

/** HRTF only where it is affordable and heard on headphones-class output: high-tier desktop. */
export function panningModelFor(tier: string, phone: boolean): PanningModelType {
  return tier === 'high' && !phone ? 'HRTF' : 'equalpower';
}

type ParamLike = { value: number };
function setParam(p: unknown, v: number): boolean {
  if (p && typeof p === 'object' && 'value' in (p as object)) {
    try { (p as ParamLike).value = v; return true; } catch { return false; }
  }
  return false;
}

/**
 * A world-positioned PannerNode doing DIRECTION only (rolloffFactor 0): distance gain, air
 * absorption and delay are applied by the caller's chain so procedural and sampled voices share
 * one law. Falls back to setPosition on engines without positionX (old Safari).
 */
export function makeWorldPanner(ctx: BaseAudioContext, pos: Vec3Like, model: PanningModelType): PannerNode {
  const p = ctx.createPanner();
  try { p.panningModel = model; } catch { /* engine without HRTF: keeps its default */ }
  try { p.distanceModel = 'inverse'; } catch { /* default */ }
  p.refDistance = 1;
  p.maxDistance = 10000;
  p.rolloffFactor = 0;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 1;
  const ok = setParam(p.positionX, pos.x) && setParam(p.positionY, pos.y) && setParam(p.positionZ, pos.z);
  if (!ok) {
    const legacy = (p as unknown as { setPosition?: (x: number, y: number, z: number) => void }).setPosition;
    if (typeof legacy === 'function') legacy.call(p, pos.x, pos.y, pos.z);
  }
  return p;
}

/**
 * Move the AudioListener to the camera: position, forward and a world-up vector. When looking
 * almost straight up or down, the flattened yaw forward is used (forward must not be parallel to
 * up). AudioParam path first, legacy setPosition / setOrientation second.
 */
export function applyListener(listener: AudioListener | null | undefined, pos: Vec3Like, forward: Vec3Like): void {
  if (!listener) return;
  let fx = forward.x, fy = forward.y, fz = forward.z;
  const l = Math.hypot(fx, fy, fz);
  if (!(l > 1e-6)) { fx = 0; fy = 0; fz = -1; } else { fx /= l; fy /= l; fz /= l; }
  if (Math.abs(fy) > 0.98) {
    const h = Math.hypot(fx, fz);
    if (h > 1e-6) { fx /= h; fz /= h; } else { fx = 0; fz = -1; }
    fy = 0;
  }
  const L = listener as unknown as Record<string, unknown>;
  const ok = setParam(L.positionX, pos.x) && setParam(L.positionY, pos.y) && setParam(L.positionZ, pos.z)
    && setParam(L.forwardX, fx) && setParam(L.forwardY, fy) && setParam(L.forwardZ, fz)
    && setParam(L.upX, 0) && setParam(L.upY, 1) && setParam(L.upZ, 0);
  if (ok) return;
  try {
    if (typeof L.setPosition === 'function') (L.setPosition as (x: number, y: number, z: number) => void).call(listener, pos.x, pos.y, pos.z);
    if (typeof L.setOrientation === 'function') {
      (L.setOrientation as (a: number, b: number, c: number, d: number, e: number, f: number) => void).call(listener, fx, fy, fz, 0, 1, 0);
    }
  } catch { /* a listener that rejects the pose keeps the last one */ }
}
