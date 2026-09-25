// Flood audio laws (b2.4d, audio-02). Pure: no Web Audio, no THREE, so
// scripts/test-flood-audio.mjs grades every number the FloodAudio voices use.
//
// A breach is heard by the physics that floods it: exit speed v = sqrt(2 g h)
// from the head over the hole (the same number floodFx draws the jet with),
// the torn area of the hole (size 1..3), and whether the hold water already
// stands over it (then it is a muffled boil, not a jet hitting the sole).
import { GRAVITY, holeSizeArea } from '../../shared/flooding/floodModel.js';
import { FLOODING } from '../../shared/constants/index.js';
import { gainFor } from './Spatial.js';

/** Most gush voices one hull gets; the deepest (fastest) breaches win. */
export const FLOOD_GUSH_VOICES = 6;
/** Hulls heard at once: the one you stand on plus the nearest others. */
export const FLOOD_MAX_SHIPS = 3;
/** Beyond this another hull's flooding is not voiced (floodFx draws to 70 m too). */
export const FLOOD_AUDIBLE_M = 70;
/** A patched breach's gush dies over this (matches FLOOD_JET_RELEASE_S). */
export const FLOOD_GUSH_RELEASE_S = 0.3;
/** Another hull's hold is heard through its planking: -6 dB and dark. */
export const FLOOD_HULL_OCCLUSION = 0.5;
export const FLOOD_HULL_OCCLUSION_CUTOFF = 1200;
/** Head (m) whose jet reads as a full-strength gush on a size-3 breach. */
export const GUSH_REF_HEAD_M = 2;
const V_REF = Math.sqrt(2 * GRAVITY * GUSH_REF_HEAD_M);
const AREA_MAX = FLOODING.HOLE_SIZE_AREA[FLOODING.HOLE_SIZE_AREA.length - 1];
/** Founder stages (fraction of the sink): groan at 0, frame cracks, air bursting, suction. */
export const FOUNDER_CUES: ReadonlyArray<{ at: number; kind: 'groan' | 'frameCrack' | 'airRelease' | 'suction' }> = [
  { at: 0, kind: 'groan' },
  { at: 0.12, kind: 'frameCrack' },
  { at: 0.3, kind: 'frameCrack' },
  { at: 0.38, kind: 'airRelease' },
  { at: 0.5, kind: 'frameCrack' },
  { at: 0.62, kind: 'airRelease' },
  { at: 0.8, kind: 'suction' },
];

function fin(n: number, d = 0): number {
  return Number.isFinite(n) ? n : d;
}
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, fin(n)));
}

export interface GushVoiceParams {
  /** 0..1 loop gain before distance. */
  level: number;
  /** Lowpass cutoff (Hz): a fast jet is bright, a boil under the hold water is dark. */
  cutoff: number;
  /** Sample playback rate: faster water, higher pitch. */
  rate: number;
}

/** Exit speed (m/s) for a head over the hole; 0 at or above the waterline. */
export function exitSpeed(headM: number): number {
  const h = fin(headM);
  return h > 0 ? Math.sqrt(2 * GRAVITY * h) : 0;
}

/**
 * The gush of one breach from its exit speed. Acoustic power of a jet grows with its
 * kinetic flux (A v^3), so amplitude goes as sqrt(A) v^1.5, soft-saturated so it stays
 * strictly increasing with depth and never passes 1.
 */
export function gushFromSpeed(v: number, size: number | undefined, submergedInside: boolean, strength = 1): GushVoiceParams {
  const speed = Math.max(0, fin(v));
  const s = clamp01(strength);
  if (speed <= 0 || s <= 0) return { level: 0, cutoff: 400, rate: 1 };
  const area = holeSizeArea(size) / AREA_MAX;
  const x = Math.sqrt(area) * Math.pow(speed / V_REF, 1.5);
  let level = 1 - Math.exp(-1.6 * x);
  const vn = Math.min(1, speed / V_REF);
  let cutoff = 700 + 2600 * vn;
  if (submergedInside) {
    // Sea pushing into water: a low churning boil, not spray on planks.
    level *= 0.6;
    cutoff = 260 + 420 * vn;
  }
  return { level: level * s, cutoff, rate: 0.82 + 0.36 * vn };
}

/** Same law from the depth of the hole under the outside waterline (m, negative = above). */
export function holeGush(depthM: number, size: number | undefined, submergedInside = false): GushVoiceParams {
  return gushFromSpeed(exitSpeed(depthM), size, submergedInside);
}

export interface GushCandidate { holeId: number; v: number; strength: number }

/** The voices to keep: fastest (deepest) first, then the id for a stable order. */
export function pickGushVoices<T extends GushCandidate>(emitters: readonly T[], cap = FLOOD_GUSH_VOICES): T[] {
  return emitters
    .filter((e) => fin(e.strength) > 0)
    .slice()
    .sort((a, b) => fin(b.v) - fin(a.v) || a.holeId - b.holeId)
    .slice(0, Math.max(0, Math.floor(cap)));
}

/** Hold water slosh: 0 dry, grows with fill and with how hard the hull rolls and pitches. */
export function sloshLevel(fill: number, rollRate: number, pitchRate: number): { level: number; cutoff: number; rate: number } {
  const f = clamp01(fill);
  if (f <= 0) return { level: 0, cutoff: 300, rate: 0.6 };
  const motion = Math.min(1, (Math.abs(fin(rollRate)) + 0.6 * Math.abs(fin(pitchRate))) / 0.3);
  return { level: 0.75 * Math.sqrt(f) * (0.3 + 0.7 * motion), cutoff: 280 + 720 * f, rate: 0.55 + 0.2 * motion };
}

/** Deep gurgle once the hold is more than half full: 0 at 0.5, 1 when awash. */
export function gurgleLevel(fill: number): number {
  const t = clamp01((fin(fill) - 0.5) / 0.5);
  return t * t * (3 - 2 * t);
}

/**
 * Distance gain for a flood voice. The hull you stand on is heard open; any other hull
 * through its planking (FLOOD_HULL_OCCLUSION), on the splash distance law.
 */
export function floodDistanceGain(distanceM: number, ownShip: boolean): number {
  const g = gainFor('splash', Math.max(0, fin(distanceM)));
  return ownShip ? g : g * FLOOD_HULL_OCCLUSION;
}

/** Hole punch crack by breach size: bigger tears are louder and lower. */
export function holePunchParams(size: number | undefined): { volume: number; rate: number } {
  const s = Math.min(3, Math.max(1, Math.round(fin(size ?? 1, 1))));
  return { volume: 0.55 + 0.2 * s, rate: 1.15 - 0.15 * s };
}

/** Founder cues crossed going from prev to next sink progress (both 0..1). */
export function founderCuesCrossed(prev: number, next: number): Array<'groan' | 'frameCrack' | 'airRelease' | 'suction'> {
  const a = fin(prev, -1);
  const b = fin(next, -1);
  const out: Array<'groan' | 'frameCrack' | 'airRelease' | 'suction'> = [];
  for (const c of FOUNDER_CUES) if (a < c.at && b >= c.at) out.push(c.kind);
  return out;
}

/** Sum of loop gains in dB (for gates): 20 log10 of the amplitude sum. */
export function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(1e-9, fin(amplitude)));
}
