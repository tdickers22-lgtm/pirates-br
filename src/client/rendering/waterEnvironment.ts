// b2.3f (holes-07): underwater in the flooded hold.
//
// Game.updateWaterEnvironment used to ask only the OUTSIDE sea
// (gerstnerHeight - camera.y), so a camera under the hold water (b2.3a) saw a
// dry hold and heard open air. The camera's water depth is now
// max(outside sea, hold water), and when the hold is the deeper water it gets
// its own palette: murky green-brown, 95% fog within 4-6 m (the sea's
// underwater fog is ~50x thinner and teal), dimmed exposure and a caustic
// flicker from the companionway hatch by day.
//
// Everything here is pure maths over the hold-water clip and plane, plus one
// apply step that only MOVES the scene's existing FogExp2 colour/density and
// the tone-mapping exposure: no material, no shader, no fog object is created,
// so no program is added (program census: 0 new).
import * as THREE from 'three';
import { clipHalfWidth, planeY, type HoldWaterClip, type HoldWaterPlane } from './ship/holdWater.js';

/** 95% fog distance band in the flooded hold (PLAN 4 b2.3f: 4-6 m). */
export const HOLD_FOG_VISIBILITY_MIN = 4;
export const HOLD_FOG_VISIBILITY_MAX = 6;
/** FogExp2 is 1 - exp(-(density d)^2): 95% at d = sqrt(-ln 0.05) / density. */
const FOG_95 = Math.sqrt(-Math.log(0.05));
/** An eye a little below the sole (crouched on a tread) still counts; a
 *  swimmer under the keel does not. */
const SOLE_MARGIN = 0.05;
/** The lining clip is inset from the loft; the eye may sit on the planking. */
const LINING_MARGIN = 0.1;
/** Hold depth over the sea depth at which the hold palette fully takes over. */
const HOLD_BLEND = 0.12;

export interface EyeLocal { x: number; y: number; z: number }

/**
 * Depth (m) of a hull-local eye below the hold-water surface, 0 when the eye
 * is not in the hold water: dry hold, above the surface, beyond the lining,
 * beyond the hold's length, above the deck or under the keel.
 */
export function holdEyeDepth(clip: HoldWaterClip, plane: HoldWaterPlane | null, local: EyeLocal): number {
  if (!plane || !eyeInsideHold(clip, local)) return 0;
  const surface = Math.min(clip.deckY, planeY(plane, local.x, local.z));
  return surface > local.y ? surface - local.y : 0;
}

/**
 * Is a hull-local eye inside the hold (between the sole and the deck, inside
 * the lining, within the hold's length)? Inside, the sea is on the far side of
 * the planking: a dry hold whose sole lies under the outside waterline (a low
 * eye, a heeled hull) is DRY, not underwater. Water in there is hold water.
 */
export function eyeInsideHold(clip: HoldWaterClip, local: EyeLocal): boolean {
  if (!(local.y >= clip.soleY - SOLE_MARGIN) || !(local.y <= clip.deckY)) return false;
  const hw = clipHalfWidth(clip, local.z, Math.min(clip.deckY, Math.max(clip.soleY, local.y)));
  return hw >= 0 && Math.abs(local.x) <= hw + LINING_MARGIN;
}

export type WaterSource = 'dry' | 'sea' | 'hold';

export interface CombinedWaterDepth {
  /** max(outside, hold): drives the audio muffle and the breath HUD. */
  depth: number;
  source: WaterSource;
  /** 0..1 weight of the hold palette over whatever the sea set. */
  holdMix: number;
}

function finitePos(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function smooth01(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export function combineWaterDepth(outsideDepth: number, holdDepth: number): CombinedWaterDepth {
  const o = finitePos(outsideDepth);
  const h = finitePos(holdDepth);
  const depth = Math.max(o, h);
  if (!(depth > 0)) return { depth: 0, source: 'dry', holdMix: 0 };
  if (h > o) return { depth, source: 'hold', holdMix: smooth01((h - o) / HOLD_BLEND) };
  return { depth, source: 'sea', holdMix: 0 };
}

/** 95% fog distance: 6 m in a calm, part-full hold, 4 m full and churning. */
export function holdVisibilityMeters(fill: number, agitation: number): number {
  const f = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0));
  const a = Math.min(1, Math.max(0, Number.isFinite(agitation) ? agitation : 0));
  const murk = Math.min(1, 0.6 * f + 0.4 * a);
  return HOLD_FOG_VISIBILITY_MAX - (HOLD_FOG_VISIBILITY_MAX - HOLD_FOG_VISIBILITY_MIN) * murk;
}

export function holdFogDensity(visibilityMeters: number): number {
  return FOG_95 / Math.max(0.5, visibilityMeters);
}

export interface HatchRect { cx: number; cz: number; halfX: number; halfZ: number }

/**
 * Daylight caustics falling through the companionway onto the hold water,
 * seen from under it: three drifting interference bands, sharpened, fading out
 * 3 m beyond the hatch opening, gone at night (the hatch shaft goes at 0.6).
 */
export function hatchCausticFlicker(localX: number, localZ: number, hatch: HatchRect, t: number, night: number): number {
  const dx = Math.max(0, Math.abs(localX - hatch.cx) - hatch.halfX);
  const dz = Math.max(0, Math.abs(localZ - hatch.cz) - hatch.halfZ);
  const near = 1 - smooth01(Math.hypot(dx, dz) / 3);
  const day = 1 - smooth01((night - 0.15) / 0.45);
  if (!(near > 0) || !(day > 0)) return 0;
  const c = (Math.sin(t * 2.1 + localX * 1.3)
    + Math.sin(t * 3.7 + localZ * 1.1 + 1.3)
    + Math.sin(t * 5.3 - localX * 0.7 + localZ * 0.9 + 2.1)) / 3;
  const v = Math.pow(Math.min(1, Math.max(0, 0.5 + 0.5 * c)), 1.5);
  return v * near * day;
}

export interface HoldPalette { r: number; g: number; b: number; density: number; exposureScale: number }

// Linear working-space colours: silty green-brown by day, near-black at night
// (the lanterns are emissive and carry their own glow through the fog).
const DAY = { r: 0.075, g: 0.1, b: 0.07 };
const NIGHT = { r: 0.018, g: 0.024, b: 0.02 };
const CAUSTIC = { r: 0.2, g: 0.24, b: 0.15 };

export function holdUnderwaterPalette(fill: number, agitation: number, night: number, flicker: number): HoldPalette {
  const n = Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0));
  const k = Math.min(1, Math.max(0, Number.isFinite(flicker) ? flicker : 0)) * 0.5;
  const vis = holdVisibilityMeters(fill, agitation);
  const murk = (HOLD_FOG_VISIBILITY_MAX - vis) / (HOLD_FOG_VISIBILITY_MAX - HOLD_FOG_VISIBILITY_MIN);
  const dim = 1 - 0.25 * murk;
  const mix = (a: number, b: number, c: number) => ((a + (b - a) * n) * dim) * (1 - k) + c * k;
  return {
    r: mix(DAY.r, NIGHT.r, CAUSTIC.r),
    g: mix(DAY.g, NIGHT.g, CAUSTIC.g),
    b: mix(DAY.b, NIGHT.b, CAUSTIC.b),
    density: holdFogDensity(vis),
    exposureScale: (0.9 - 0.1 * murk) * (1 + 0.12 * k),
  };
}

const tmpColor = new THREE.Color();

/**
 * Lay the hold palette over what Renderer.updateWaterEnvironment just set
 * (it rewrites fog and exposure from scratch every frame, so this never
 * accumulates). mix 0 is a no-op.
 */
export function applyHoldUnderwater(
  fog: THREE.Fog | THREE.FogExp2 | null,
  gl: { toneMappingExposure: number },
  palette: HoldPalette,
  mix: number,
): void {
  const m = Math.min(1, Math.max(0, Number.isFinite(mix) ? mix : 0));
  if (!(m > 0)) return;
  if (fog) {
    fog.color.lerp(tmpColor.setRGB(palette.r, palette.g, palette.b), m);
    if (fog instanceof THREE.FogExp2) fog.density += (palette.density - fog.density) * m;
  }
  gl.toneMappingExposure *= 1 + (palette.exposureScale - 1) * m;
}
