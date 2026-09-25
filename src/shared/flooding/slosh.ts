// THE hold-water slosh (b2.2c, holes-02 / liveplay-02). Pure and deterministic:
// the server's FloodSystem owns one SloshState per hull and steps it every tick;
// the list and trim it produces reach the client through ship.roll / ship.pitch
// (nothing new on the wire). The client hold-water plane may evaluate the same
// geometry to tilt its surface.
//
// Two degrees of freedom: the water centroid's hull-local offset across (x,
// port +) and along (z, bow +) the hold. Each is a damped oscillator at the
// FIRST SLOSHING MODE of the free surface (rectangular-tank dispersion,
// omega^2 = (pi g / b) tanh(pi d / b), b the free-surface width or length, d
// the water depth) with damping ratio 0.1, chasing a target:
//
//   across: the FREE SURFACE runs to the low rail: a shift of
//     SLOSH_FS_F x b^2 / (12 d) per radian of heel (the free-surface lever
//     i/V of the section, SLOSH_FS_F for the frames and cargo that break it
//     up), saturating at the wedge limit of the section (shallow water lies
//     against the low side, b/6; deep water meets the deck underside,
//     b (H - d) / (6 d); a full hold has no free surface and cannot shift).
//     That is the free-surface GM loss: she rolls further and slower half full.
//   memory: water that came in through a breach LIES where it came in (the
//     keelson, ballast and cargo keep it on that side and at that end), mixed
//     by volume with what was already aboard. Bailing takes water out
//     uniformly, so the offset stays and the list and trim it gives PERSIST
//     after every hole is planked until the water is bailed out (PLAN 3.6);
//     the list shrinks with the mass. The offset is capped at the wedge limit
//     and at SLOSH_LIST_MAX of list, so the water alone never lays her over.
import type { ShipType } from '../types/index.js';
import { getHullProfile, hullSurfacePointAt } from '../hull.js';
import { getHullVolumeTable, fillToLocalY } from './hullVolume.js';

const G = 9.81;
/** Damping ratio of the first sloshing mode (PLAN 4 b2.2c). */
export const SLOSH_ZETA = 0.1;
/** Share of the section's free-surface lever b^2 / (12 d) the hold keeps. */
export const SLOSH_FS_F = 0.45;
/** Share of the geometric wedge limit the water reaches. */
export const SLOSH_SAT_F = 0.75;
/** Ceiling (rad) of the list the remembered offset alone gives. */
export const SLOSH_LIST_MAX = 0.12;

export interface SloshState {
  /** Centroid offset (m, hull-local; x port +, z bow +) and its rate. */
  x: number; vx: number; z: number; vz: number;
  /** Where the inflow put the water (m), before it spreads. */
  memX: number; memZ: number;
}

export function newSloshState(): SloshState {
  return { x: 0, vx: 0, z: 0, vz: 0, memX: 0, memZ: 0 };
}

export interface SloshGeometry {
  /** Free-surface width (m, mean over the hold) and length, water depth (m). */
  b: number; l: number; d: number;
  /** First sloshing mode, across and along (rad/s). */
  omegaX: number; omegaZ: number;
  /** Largest centroid shift the section allows across / along (m). */
  xSat: number; zSat: number;
}

const FILL_STEPS = 40;
const GEOM = new Map<ShipType, SloshGeometry[]>();

function modeOmega(span: number, depth: number): number {
  const s = Math.max(0.2, span);
  return Math.sqrt(((Math.PI * G) / s) * Math.tanh((Math.PI * Math.max(0.01, depth)) / s));
}

function wedgeShift(span: number, depth: number, headroom: number): number {
  const d = Math.max(0.01, depth);
  return Math.max(0, Math.min(span / 6, (span * Math.max(0, headroom)) / (6 * d)));
}

function buildGeometry(type: ShipType): SloshGeometry[] {
  const vt = getHullVolumeTable(type);
  const profile = getHullProfile(type);
  const holdL = profile.L * 0.9;
  const out: SloshGeometry[] = [];
  for (let i = 0; i <= FILL_STEPS; i += 1) {
    const f = i / FILL_STEPS;
    const y = fillToLocalY(type, f);
    let hw = 0; let wet = 0;
    const n = 24;
    for (let k = 0; k < n; k += 1) {
      const z = -holdL * 0.5 + ((k + 0.5) * holdL) / n;
      const x = Math.max(0, hullSurfacePointAt(profile, z, y).x);
      hw += x;
      if (x > 0.05) wet += holdL / n;
    }
    const b = Math.max(0.2, (2 * hw) / n);
    const l = Math.max(0.2, wet);
    const d = Math.max(0, y - vt.soleY);
    const headroom = vt.deckY - y;
    out.push({
      b, l, d,
      omegaX: modeOmega(b, d),
      omegaZ: modeOmega(l, d),
      xSat: f <= 0 ? 0 : SLOSH_SAT_F * wedgeShift(b, d, headroom),
      zSat: f <= 0 ? 0 : SLOSH_SAT_F * wedgeShift(l, d, headroom),
    });
  }
  return out;
}

/** Slosh geometry at a volume fill (interpolated from a per-class table). */
export function sloshGeometry(type: ShipType, fill: number): SloshGeometry {
  let table = GEOM.get(type);
  if (!table) { table = buildGeometry(type); GEOM.set(type, table); }
  const f = Math.min(1, Math.max(0, Number.isFinite(fill) ? fill : 0)) * FILL_STEPS;
  const i = Math.min(FILL_STEPS - 1, Math.floor(f));
  const u = f - i;
  const a = table[i]; const c = table[i + 1];
  const mix = (p: number, q: number) => p + (q - p) * u;
  return {
    b: mix(a.b, c.b), l: mix(a.l, c.l), d: mix(a.d, c.d),
    omegaX: mix(a.omegaX, c.omegaX), omegaZ: mix(a.omegaZ, c.omegaZ),
    xSat: mix(a.xSat, c.xSat), zSat: mix(a.zSat, c.zSat),
  };
}

/** Everything the step needs from the hull (FloodSystem supplies it). */
export interface SloshHull {
  type: ShipType;
  fill: number;
  /** Water mass (kg) and the hull's righting stiffness in roll (N m / rad). */
  mass: number;
  kRoll: number;
  /** Live attitude (rad): +roll lifts +x, +pitch dips the bow. */
  roll: number;
  pitch: number;
}

/** Largest remembered offset across (m) at this fill and mass. */
export function sloshLimitX(geom: SloshGeometry, hull: SloshHull): number {
  if (!(hull.mass > 0) || !(hull.kRoll > 0) || !(geom.xSat > 0)) return 0;
  const perMetre = (hull.mass * G) / hull.kRoll; // list (rad) per metre of shift
  return Math.min(SLOSH_LIST_MAX / perMetre, geom.xSat);
}

/** Target centroid across: the remembered offset plus the free surface. */
export function sloshTargetX(geom: SloshGeometry, hull: SloshHull, memX: number): number {
  const lim = sloshLimitX(geom, hull);
  if (!(lim > 0)) return 0;
  const lever = (SLOSH_FS_F * geom.b * geom.b) / (12 * Math.max(0.05, geom.d));
  const fs = -geom.xSat * Math.tanh((lever * Math.tan(hull.roll)) / geom.xSat);
  return Math.max(-lim, Math.min(lim, memX)) + fs;
}

/** Target centroid along for a trim. */
export function sloshTargetZ(geom: SloshGeometry, _hull: SloshHull, memZ: number): number {
  const lin = (geom.l * geom.l) / (12 * Math.max(0.05, geom.d));
  const fromTrim = geom.zSat > 0 ? geom.zSat * Math.tanh((lin * Math.tan(_hull.pitch)) / geom.zSat) : 0;
  return Math.max(-geom.zSat, Math.min(geom.zSat, memZ)) + fromTrim;
}

/**
 * Advance the centroid one tick. `inflow` lists the water that came in this
 * tick (fill fraction) and where (hull-local x, z); it is mixed into the
 * memory by volume before the memory relaxes.
 */
export function stepSlosh(
  state: SloshState,
  hull: SloshHull,
  dt: number,
  prevFill: number,
  inflow: ReadonlyArray<{ amount: number; x: number; z: number }> = [],
): SloshState {
  if (!(hull.fill > 1e-4) || !(dt > 0)) {
    state.x = 0; state.vx = 0; state.z = 0; state.vz = 0; state.memX = 0; state.memZ = 0;
    return state;
  }
  const geom = sloshGeometry(hull.type, hull.fill);
  let vol = Math.max(0, prevFill);
  let mx = state.memX * vol;
  let mz = state.memZ * vol;
  for (const q of inflow) {
    if (!(q.amount > 0)) continue;
    vol += q.amount; mx += q.amount * q.x; mz += q.amount * q.z;
  }
  if (vol > 1e-6) { state.memX = mx / vol; state.memZ = mz / vol; }
  // The memory is the volume-weighted inflow position itself (bounded by the
  // hull); the fill-dependent cap is applied where it is read, so a hull
  // bailed down from 0.8 regains the offset its shallower water allows.
  const capX = sloshLimitX(geom, hull);

  const tx = sloshTargetX(geom, hull, state.memX);
  const tz = sloshTargetZ(geom, hull, state.memZ);
  const ax = geom.omegaX * geom.omegaX * (tx - state.x) - 2 * SLOSH_ZETA * geom.omegaX * state.vx;
  const az = geom.omegaZ * geom.omegaZ * (tz - state.z) - 2 * SLOSH_ZETA * geom.omegaZ * state.vz;
  state.vx += ax * dt; state.x += state.vx * dt;
  state.vz += az * dt; state.z += state.vz * dt;
  const spanX = capX + geom.xSat; const spanZ = 2 * geom.zSat;
  state.x = Math.max(-spanX, Math.min(spanX, state.x));
  state.z = Math.max(-spanZ, Math.min(spanZ, state.z));
  return state;
}

