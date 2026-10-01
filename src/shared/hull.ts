// ─────────────────────────────────────────────────────────────────────────────
// THE HULL LOFT — one shared shape, no three.js.
//
// Four hand-kept tables used to describe the same hull (ships-24): the
// renderer's LOFT_STATIONS, the swim footprint's SWIM_HULL_STATIONS, the
// server's HULL_CONTACT_STATIONS and a box-face hullFacePoint. This module is
// the survivor: pure numbers, importable by BOTH src/server and src/client, so
// the drawn planking, the deck a pirate stands on and the surface a shot enters
// can be derived from ONE set of stations instead of mirrored by hand.
//
// Phase 1 (DECK-01) moves the renderer's loft here BIT-IDENTICALLY — the
// snapshot gate scripts/test-hull-loft.mjs pins every derived slot against the
// values the renderer produced before the move, so no shape change can ride in
// under a refactor. Phase 2 (LOFT-01, wave 3.6) derives the other three tables
// from these functions.
//
// The stations describe the STARBOARD half-section, sheer (deck edge) at the
// top → keel at the bottom; mirror x for port. The sheer half-widths are NOT
// the walkable deck line: pirates are clamped to the bulwark inner face
// (getShipDeckWalkHalfWidth), which stays inboard of the loft sheer at every z.
// ─────────────────────────────────────────────────────────────────────────────

import type { ShipType } from './types/index.js';
import { SHIP_STATS } from './constants/index.js';

/** Local clamp — this module must not import three.js (the server reads it).
 *  Identical to THREE.MathUtils.clamp, which is what the renderer used. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface HullProfileStation {
  baseZ: number;
  sheerY: number;
  keelY: number;
  /** Starboard half-section, sheer(0) → keel(last). x >= 0. */
  slots: Array<{ x: number; y: number; z: number }>;
}

export interface HullProfile {
  W: number;
  H: number;
  L: number;
  draft: number;
  stations: HullProfileStation[];
}

/** Per-class hull character: tumblehome bulge at the wale and draft fraction. */
export const HULL_SHAPES: Record<ShipType, { bulge: number; draftF: number }> = {
  sloop: { bulge: 1.045, draftF: 0.365 },      // draft ≈ 0.80m
  brigantine: { bulge: 1.07, draftF: 0.36 },   // draft ≈ 1.01m
  galleon: { bulge: 1.10, draftF: 0.35 },      // draft ≈ 1.23m
};

/** Loft stations. `dh` (sheer half-width, fraction of W) draws the covering
 *  board — the visible deck edge. It must stay OUTBOARD of the shared walk
 *  taper getShipDeckWalkHalfWidth (stations −0.5:0.23, −0.36:0.38, −0.08:0.42,
 *  0.22:0.40, 0.42:0.30, 0.5:0.05 · W) at every z, so the deck clamp can never
 *  strand a pirate past a rendered line. Checked at the knots and the crossings:
 *  the tightest margins are the forward quarter (z 0.42 → 0.32 vs 0.30 W) and
 *  the stem (z 0.5 → 0.055 vs 0.05 W); everything else clears by ≥0.02 W.
 *  ztF/zbF give the stem/stern rake (z at sheer vs keel). */
export const LOFT_STATIONS = [
  { zf: -0.50, dh: 0.300, sheer: 0.95,  keel01: 0.32, wlF: 0.62, bilgeF: 0.34, mid: 0.15, ztF: -0.505, zbF: -0.415 },
  { zf: -0.36, dh: 0.500, sheer: 0.98,  keel01: 0.74, wlF: 0.76, bilgeF: 0.48, mid: 0.75, ztF: -0.360, zbF: -0.350 },
  { zf: -0.22, dh: 0.530, sheer: 0.99,  keel01: 0.90, wlF: 0.80, bilgeF: 0.52, mid: 0.95, ztF: -0.220, zbF: -0.220 },
  { zf: -0.08, dh: 0.560, sheer: 1.00,  keel01: 1.00, wlF: 0.82, bilgeF: 0.54, mid: 1.00, ztF: -0.080, zbF: -0.080 },
  { zf:  0.07, dh: 0.520, sheer: 0.995, keel01: 1.00, wlF: 0.80, bilgeF: 0.52, mid: 1.00, ztF:  0.070, zbF:  0.070 },
  { zf:  0.22, dh: 0.480, sheer: 0.99,  keel01: 0.92, wlF: 0.74, bilgeF: 0.46, mid: 0.90, ztF:  0.220, zbF:  0.220 },
  // Forward quarter widened (0.370→0.390, 0.260→0.320): the walk taper runs
  // 0.35 W / 0.30 W here, so the old sheer left the clamp up to 0.04 W (0.4 m on
  // a galleon) OUTBOARD of the drawn deck edge — an invisible rail at the bow.
  { zf:  0.32, dh: 0.390, sheer: 1.015, keel01: 0.78, wlF: 0.62, bilgeF: 0.36, mid: 0.60, ztF:  0.325, zbF:  0.310 },
  { zf:  0.42, dh: 0.320, sheer: 1.04,  keel01: 0.55, wlF: 0.46, bilgeF: 0.24, mid: 0.30, ztF:  0.445, zbF:  0.405 },
  // Stem head (b4.2b2, ships-01): the forefoot sits at 0.45 draft, 0.45 L (was
  // 0.18 draft at 0.415 L). The old rabbet climbed 0.37 draft in 0.01 L, the
  // same way the stem profile runs down, so the bow patch had a 166 deg corner:
  // 50 deg along-length creases and inboard normals on any smooth loft.
  { zf:  0.50, dh: 0.055, sheer: 1.08,  keel01: 0.45, wlF: 0.30, bilgeF: 0.14, mid: 0.00, ztF:  0.530, zbF:  0.450 },
];

const HULL_PROFILE_CACHE = new Map<ShipType, HullProfile>();
/** Loft station -> the profile and index it was built for, so stationSurfaceAt
 *  (which only receives the station) can read that station's spline row. */
const STATION_OWNER = new WeakMap<HullProfileStation, { profile: HullProfile; index: number }>();

type LoftStationDef = (typeof LOFT_STATIONS)[number];

/** One station's starboard half-section from its table row. Shared by the loft
 *  (getHullProfile) and the spline table (getHullSplineStations), so a spline
 *  row and a loft row with the same numbers are the same bits. */
function buildLoftStation(def: LoftStationDef, W: number, H: number, L: number, draft: number, bulge: number): HullProfileStation {
  const sheerY = def.sheer * H;
  const keelY = -draft * def.keel01;
  const dh = def.dh * W;
  const wale = dh * (1 + (bulge - 1) * def.mid);
  const wl = dh * def.wlF;
  const bilge = dh * def.bilgeF;
  const waleY = sheerY * 0.60;
  const zt = def.ztF * L;
  const zb = def.zbF * L;
  const span = Math.max(0.001, sheerY - keelY);
  const zAt = (y: number) => {
    const vf = clamp((sheerY - y) / span, 0, 1);
    return zt + (zb - zt) * Math.pow(vf, 1.35); // stem/stern curve, not a straight rake
  };
  const slot = (x: number, y: number) => ({ x, y, z: zAt(y) });
  return {
    baseZ: def.zf * L,
    sheerY,
    keelY,
    slots: [
      slot(dh, sheerY),
      slot(dh + (wale - dh) * 0.72, sheerY - (sheerY - waleY) * 0.45),
      slot(wale, waleY),
      slot(wl + (wale - wl) * 0.62, waleY * 0.5),
      slot(wl, 0),
      slot(bilge, keelY * 0.52),
      slot(W * 0.015, keelY),
    ],
  };
}

export function getHullProfile(type: ShipType): HullProfile {
  let profile = HULL_PROFILE_CACHE.get(type);
  if (profile) return profile;
  const stats = SHIP_STATS[type];
  const { bulge, draftF } = HULL_SHAPES[type];
  const W = stats.width, H = stats.height, L = stats.length;
  const draft = H * draftF;
  const stations: HullProfileStation[] = LOFT_STATIONS.map((def) => buildLoftStation(def, W, H, L, draft, bulge));
  profile = { W, H, L, draft, stations };
  stations.forEach((st, index) => STATION_OWNER.set(st, { profile: profile!, index }));
  HULL_PROFILE_CACHE.set(type, profile);
  return profile;
}

/** Hull texture V for a local height — the whole shell (keel → highest sheer)
 *  maps 0..1 so the painted waterline/wale bands land on the right planks. */
export function hullUvV(profile: HullProfile, y: number): number {
  return clamp((y + profile.draft) / (profile.H * 1.08 + profile.draft), 0, 1);
}

/** One station's side at height y, ON THE SPLINE (b4.2c, ships-01): the point
 *  of the station's spline row (the PCHIP girth curve through its 7 slots that
 *  the shell is lofted through) at that height. Returns surface x, the raked z
 *  there and the outward 2D section normal (starboard sense: the surface normal
 *  projected on the x-y plane). A station that did not come from getHullProfile
 *  falls back to its slot polyline. */
export function stationSurfaceAt(st: HullProfileStation, y: number): { x: number; z: number; nx: number; ny: number } {
  const owner = STATION_OWNER.get(st);
  if (!owner) return polylineSurfaceAt(st, y);
  const rows = getSplineRows(owner.profile);
  const row = rows.find((r) => r.kind === 'loft' && r.loftIndex === owner.index)!;
  const s = surfaceAt(rows, row.u, rowTAtY(row, y));
  const len = Math.hypot(s.nx, s.ny) || 1;
  return { x: s.x, z: s.z, nx: s.nx / len, ny: s.ny / len };
}

/** The pre-spline polyline section (linear between slots), for stations built
 *  outside getHullProfile only. */
function polylineSurfaceAt(st: HullProfileStation, y: number): { x: number; z: number; nx: number; ny: number } {
  const slots = st.slots;
  let j = 0;
  const yc = clamp(y, slots[slots.length - 1].y, slots[0].y);
  while (j < slots.length - 2 && yc < slots[j + 1].y) j++;
  const a = slots[j], b = slots[j + 1];
  const t = clamp((a.y - yc) / Math.max(0.0001, a.y - b.y), 0, 1);
  let nx = a.y - b.y;
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, nx: nx / len, ny: ny / len };
}

/** Surface point + outward section normal anywhere on the hull at local (z, y),
 *  ON THE SPLINE (b4.2c): the point of sampleHullSurface's surface with that z
 *  and that y (a 2D Newton solve on the surface, clamped to the shell: above
 *  the sheer reads the sheer, below the keel the keel, past the transom or the
 *  stem line their edge). Starboard side; mirror x/nx for port. (nx, ny) is the
 *  normal of the z-section, i.e. the surface normal projected on x-y. Used to
 *  anchor gunports, rivets and hole decals, and by the flood volume table. */
export function hullSurfacePointAt(profile: HullProfile, z: number, y: number): { x: number; nx: number; ny: number } {
  const s = solveHullZY(getSplineRows(profile), z, y);
  const len = Math.hypot(s.nx, s.ny) || 1;
  return { x: s.x, nx: s.nx / len, ny: s.ny / len };
}

// ─── THE SPLINE LOFT (b4.2b, ships-01 / ships-08) ─────────────────────────────
//
// The station table above, sampled as ONE C1 surface instead of bilinear quads
// between knots: a monotone cubic (PCHIP, Fritsch-Butland slopes) through the 7
// slots of each station along the girth, and a centripetal Catmull-Rom through
// the stations along the length. The linear loft turned 25-40 deg between
// adjacent faces at the bilge and pinched the bow from 0.32 W to 0.055 W in a
// single facet; aft of the bow (station 7) the spline turns < 5 deg per girth face
// on the 72 x 40 LOD0 sampling (b4.2b2 spec: >= 40 girth samples per side).
//
// The spline table is the 9 loft rows BIT-FOR-BIT (buildLoftStation) plus three
// rows only the spline reads, so getHullProfile, the waterline outline and the
// contact chain do not move until b4.2c switches every consumer at once:
//  • COUNTER (aft quarter): full above the waterline, fine below, raked between
//    the transom and station 1, so the stern overhangs a fine run to the
//    sternpost instead of hanging a box over the water. The transom row itself
//    (station 0, ~20 deg rake) is unchanged: the rake is kept, never reduced.
//  • FLARE (bow): a station between the forward quarter and the stem head, so
//    the entry is lofted, not one facet.
//  • STEM: the stem line closing the bow (x = the stem's half-siding), a lofted
//    profile curve instead of a flat cap.
//
// u runs stern (0) → stem (1) on centripetal knots shared by every girth line
// (C1 in u for any v). GEOMETRY and SAMPLING are split (b4.2b3):
//  • the surface G(u, t) lofts rows whose girth parameter t is ARC LENGTH
//    inside each slot interval, with slot k on the same t on every row. Every
//    row then means the same thing by "t", so the length-wise spline blends
//    like with like. (Turning-weighted rows put one t on different places of
//    different sections; blending those wrinkled the bow: 244-278 deg of
//    normal path turning sheer -> keel at u 0.92 for a net 60 deg.)
//  • v (what callers pass) is mapped to t per row so uniform v spends its
//    vertices where THE SURFACE NORMAL turns (bilge, tumblehome, the garboard
//    into the keel in the bow), measured on G itself at the row's u, then
//    blended between rows with a smoothstep in u (weights >= 0, so v -> t
//    stays monotone; zero u-slope at the knots, so the surface stays C1).
//    The normal of G(u, t(u, v)) is G's normal: sampling never bends the hull.
// Pure numbers, no three.js, deterministic: the server reads this too.

/** Spline-only rows, same fields as LOFT_STATIONS (dh etc. as fractions). */
const SPLINE_COUNTER_ROW: LoftStationDef = {
  zf: -0.44, dh: 0.430, sheer: 0.965, keel01: 0.50, wlF: 0.68, bilgeF: 0.38, mid: 0.45, ztF: -0.440, zbF: -0.383,
};
const SPLINE_FLARE_ROW: LoftStationDef = {
  zf: 0.465, dh: 0.215, sheer: 1.06, keel01: 0.50, wlF: 0.42, bilgeF: 0.26, mid: 0.12, ztF: 0.488, zbF: 0.430,
};
/** Stem half-siding (fraction of W) and how far the stem line stands forward
 *  of the stem-head station (fraction of L, at the sheer → at the forefoot). */
const STEM_HALF_SIDING_F = 0.010;
const STEM_LEAD_SHEER_F = 0.014;
const STEM_LEAD_KEEL_F = 0.004;
/** Girth SAMPLING (v -> t): 0 = arc length, 1 = surface-normal turning only. */
const GIRTH_TURN_WEIGHT = 0.96;
/** Dense samples per slot interval when a v -> t map is measured on G. */
const GIRTH_SAMPLE_DENSE = 64;

type Vec3 = { x: number; y: number; z: number };

export interface HullSplineStation {
  kind: 'loft' | 'counter' | 'flare' | 'stem';
  /** Index into profile.stations for a loft row, −1 for spline-only rows. */
  loftIndex: number;
  /** Station knot along the length, 0 (transom) … 1 (stem line). */
  u: number;
  /** Girth parameter of each slot, 0 (sheer) … 1 (keel). */
  girthKnots: number[];
  slots: Vec3[];
  /** Slot indices whose x the fairing pass raised to the keel siding. */
  faired: ReadonlyArray<number>;
}

interface SplineRow extends HullSplineStation {
  faired: number[];
  /** Chord-length base knots s of the slots, and PCHIP slopes d(x,y,z)/ds. */
  g0: number[];
  mx: number[]; my: number[]; mz: number[];
  /** Slot x / y / z channels (the slots never move after makeRow faired them). */
  cx: number[]; cy: number[]; cz: number[];
  /** The v → s map (buildGirthMap). */
  vk: number[]; sk: number[]; sm: number[];
  /** Section turning (rad) and arc share of each slot interval, for the shared knots. */
  intervalTurn: number[]; intervalArc: number[];
  /** Geometry girth knots: slot k sits on t = tKnots[k] on every row. */
  tKnots: number[];
}

/** A v -> t sampling map measured on G at one u: PCHIP knots (mv -> mt), slopes. */
interface SampleMap { u: number; mv: number[]; mt: number[]; mm: number[]; slotV: number[] }

export interface HullSurfaceSample {
  x: number; y: number; z: number;
  /** Outward unit normal (starboard; mirror x/nx for port). */
  nx: number; ny: number; nz: number;
}

/** Fritsch-Butland monotone slopes on non-uniform knots: no overshoot between
 *  slots (a slot that is a local extreme, like the wale, gets zero slope),
 *  secant slopes at the two ends. */
function pchipSlopes(g: number[], f: number[]): number[] {
  const n = f.length;
  const h: number[] = [], d: number[] = [];
  for (let k = 0; k < n - 1; k++) { h.push(g[k + 1] - g[k]); d.push((f[k + 1] - f[k]) / h[k]); }
  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) { m[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
  }
  return m;
}

/** PCHIP evaluation on knots g with values f and slopes m: [value, d/dparam]. */
function pchipEval(g: number[], f: number[], m: number[], x: number): [number, number] {
  let lo = 0, hi = g.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (g[mid] <= x) lo = mid; else hi = mid - 1; }
  const k = lo, h = g[k + 1] - g[k];
  const t = clamp((x - g[k]) / h, 0, 1);
  const t2 = t * t, t3 = t2 * t;
  const val = (2 * t3 - 3 * t2 + 1) * f[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * f[k + 1] + (t3 - t2) * h * m[k + 1];
  const der = ((6 * t2 - 6 * t) * f[k] + (-6 * t2 + 6 * t) * f[k + 1]) / h + (3 * t2 - 4 * t + 1) * m[k] + (3 * t2 - 2 * t) * m[k + 1];
  return [val, der];
}

/** Dense samples of the girth curve per base interval (chord-length param). */
const GIRTH_DENSE = 24;

/**
 * The girth GEOMETRY parameter t → s. The section curve is a PCHIP in s
 * (chord-length knots through the 7 slots); t is the cumulative ARC LENGTH
 * measured on that curve (b4.2b3: it was a turning blend, which made one t a
 * different place on different sections and wrinkled the bow loft). The map is
 * itself a PCHIP through ~150 (t, s) pairs that include the 7 slots exactly, so
 * the surface still passes through every slot and stays C1 (ds/dt > 0). Where
 * uniform samples land is the sampling map's job (buildSampleMap).
 */
function measureGirth(row: { slots: Vec3[]; g0: number[]; mx: number[]; my: number[]; mz: number[] }): { sk: number[]; vk: number[]; slotAt: number[]; intervalTurn: number[]; intervalArc: number[] } {
  const xs = row.slots.map((p) => p.x), ys = row.slots.map((p) => p.y), zs = row.slots.map((p) => p.z);
  const sk: number[] = [];
  const slotAt: number[] = [];
  for (let k = 0; k < row.g0.length - 1; k++) {
    slotAt.push(sk.length);
    for (let j = 0; j < GIRTH_DENSE; j++) sk.push(row.g0[k] + (row.g0[k + 1] - row.g0[k]) * (j / GIRTH_DENSE));
  }
  slotAt.push(sk.length);
  sk.push(1);
  const tangent = (sv: number) => {
    const tx = pchipEval(row.g0, xs, row.mx, sv)[1], ty = pchipEval(row.g0, ys, row.my, sv)[1], tz = pchipEval(row.g0, zs, row.mz, sv)[1];
    const l = Math.hypot(tx, ty, tz) || 1;
    return [tx / l, ty / l, tz / l];
  };
  const pts = sk.map((sv) => [pchipEval(row.g0, xs, row.mx, sv)[0], pchipEval(row.g0, ys, row.my, sv)[0], pchipEval(row.g0, zs, row.mz, sv)[0]]);
  const arc = [0], turn = [0];
  let prevT = tangent(0);
  for (let j = 1; j < sk.length; j++) {
    arc.push(arc[j - 1] + Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1], pts[j][2] - pts[j - 1][2]));
    const t = tangent(sk[j]);
    turn.push(turn[j - 1] + Math.acos(clamp(prevT[0] * t[0] + prevT[1] * t[1] + prevT[2] * t[2], -1, 1)));
    prevT = t;
  }
  const A = arc[arc.length - 1] || 1;
  const intervalTurn: number[] = [], intervalArc: number[] = [];
  for (let k = 0; k < slotAt.length - 1; k++) {
    intervalTurn.push(turn[slotAt[k + 1]] - turn[slotAt[k]]);
    intervalArc.push((arc[slotAt[k + 1]] - arc[slotAt[k]]) / A);
  }
  // GEOMETRY parameter: arc length (b4.2b3); the turning lives in the v -> t
  // sampling map (buildSampleMap), measured on the lofted surface.
  const vk = sk.map((_, j) => (arc[j] / A) * (1 - 1e-6) + 1e-6 * j / (sk.length - 1));
  vk[vk.length - 1] = 1;
  return { sk, vk, slotAt, intervalTurn, intervalArc };
}

/** Re-target a station's measured v so slot k lands on the SHARED knot V[k]
 *  (the same girth line on every station), keeping the station's own spacing
 *  inside each slot interval. */
function girthMapOnKnots(m: { sk: number[]; vk: number[]; slotAt: number[] }, V: number[]): { vk: number[]; sk: number[]; sm: number[]; girthKnots: number[] } {
  const vk = m.vk.slice();
  for (let k = 0; k < m.slotAt.length - 1; k++) {
    const j0 = m.slotAt[k], j1 = m.slotAt[k + 1];
    const a = m.vk[j0], b = m.vk[j1];
    for (let j = j0; j <= j1; j++) vk[j] = V[k] + (V[k + 1] - V[k]) * ((m.vk[j] - a) / (b - a));
  }
  return { vk, sk: m.sk, sm: pchipSlopes(vk, m.sk), girthKnots: V.slice() };
}

/** FAIRING: below the waterline no slot may sit inboard of the keel's
 *  half-siding (the last slot). The stem-head row has its bilge at 0.0077 W
 *  against a 0.015 W keel, a 4-7 cm notch the linear loft hid in one facet but
 *  a smooth surface would turn its normals right round through. y and z never
 *  move; the raised slots are reported (faired) and graded. */
function fairSection(slots: Vec3[]): number[] {
  const keelX = slots[slots.length - 1].x;
  const raised: number[] = [];
  for (let k = 4; k < slots.length - 1; k++) {
    if (slots[k].x < keelX) { slots[k].x = keelX; raised.push(k); }
  }
  return raised;
}

function makeRow(kind: HullSplineStation['kind'], loftIndex: number, slots: Vec3[], baseFrom?: SplineRow): SplineRow {
  const faired = fairSection(slots);
  const chord = [0];
  for (let k = 1; k < slots.length; k++) {
    chord.push(chord[k - 1] + Math.hypot(slots[k].x - slots[k - 1].x, slots[k].y - slots[k - 1].y, slots[k].z - slots[k - 1].z));
  }
  // A row derived from another (the stem line from the stem head) borrows its
  // base knots and girth measure so one v is one slot height on both.
  const g0 = baseFrom ? baseFrom.g0 : chord.map((c, k) => (k === slots.length - 1 ? 1 : c / chord[chord.length - 1]));
  const base = {
    g0,
    mx: pchipSlopes(g0, slots.map((p) => p.x)),
    my: pchipSlopes(g0, slots.map((p) => p.y)),
    mz: pchipSlopes(g0, slots.map((p) => p.z)),
  };
  const m = baseFrom
    ? { sk: baseFrom.sk, vk: baseFrom.vk, slotAt: [] as number[], intervalTurn: baseFrom.intervalTurn, intervalArc: baseFrom.intervalArc }
    : measureGirth({ slots, ...base });
  return {
    kind, loftIndex, u: 0, slots, faired, ...base,
    cx: slots.map((p) => p.x), cy: slots.map((p) => p.y), cz: slots.map((p) => p.z), vk: m.vk, sk: m.sk, sm: [], girthKnots: m.slotAt.map((j) => m.vk[j]),
    intervalTurn: m.intervalTurn, intervalArc: m.intervalArc, tKnots: [],
  };
}

const SPLINE_CACHE = new WeakMap<HullProfile, SplineRow[]>();
const SAMPLE_MAP_CACHE = new WeakMap<SplineRow[], SampleMap[]>();

function getSplineRows(profile: HullProfile): SplineRow[] {
  let rows = SPLINE_CACHE.get(profile);
  if (rows) return rows;
  const { W, H, L, draft } = profile;
  // Station 3 has mid = 1, so its wale / sheer ratio IS the class bulge.
  const st3 = profile.stations[3];
  const bulge = st3.slots[2].x / st3.slots[0].x;
  rows = [];
  profile.stations.forEach((st, i) => {
    rows!.push(makeRow('loft', i, st.slots.map((p) => ({ x: p.x, y: p.y, z: p.z }))));
    if (i === 0) rows!.push(makeRow('counter', -1, buildLoftStation(SPLINE_COUNTER_ROW, W, H, L, draft, bulge).slots));
    if (i === profile.stations.length - 2) rows!.push(makeRow('flare', -1, buildLoftStation(SPLINE_FLARE_ROW, W, H, L, draft, bulge).slots));
  });
  const head = profile.stations[profile.stations.length - 1];
  const n = head.slots.length;
  const headRow = rows[rows.length - 1];
  rows.push(makeRow('stem', -1, headRow.slots.map((p, k) => ({
    x: Math.min(p.x, W * STEM_HALF_SIDING_F) * 0.999,
    y: p.y,
    z: p.z + L * (STEM_LEAD_SHEER_F + (STEM_LEAD_KEEL_F - STEM_LEAD_SHEER_F) * (k / (n - 1))),
  })), headRow));
  // Shared geometry knots: slot k sits on the same t on every station, each
  // interval sized by the longest arc share any station has there.
  const measured = rows.filter((r) => r.kind !== 'stem');
  const need = new Array<number>(n - 1).fill(0);
  for (const r of measured) {
    for (let k = 0; k < n - 1; k++) if (r.intervalArc[k] > need[k]) need[k] = r.intervalArc[k];
  }
  const needSum = need.reduce((a, x) => a + x, 0);
  const V = [0];
  for (let k = 0; k < n - 1; k++) V.push(V[k] + need[k] / needSum);
  V[n - 1] = 1;
  for (const r of rows) {
    if (r.kind === 'stem') continue;
    const slotAt = r.girthKnots.map((g) => r.vk.indexOf(g));
    const mapped = girthMapOnKnots({ sk: r.sk, vk: r.vk, slotAt }, V);
    r.vk = mapped.vk; r.sm = mapped.sm; r.girthKnots = mapped.girthKnots; r.tKnots = V.slice();
  }
  const stemRow = rows[rows.length - 1];
  stemRow.vk = headRow.vk; stemRow.sk = headRow.sk; stemRow.sm = headRow.sm; stemRow.tKnots = V.slice();
  // Centripetal knots along the length, one sequence for every girth line.
  const t = [0];
  for (let i = 0; i < rows.length - 1; i++) {
    let acc = 0;
    for (let k = 0; k < n; k++) {
      const a = rows[i].slots[k], b = rows[i + 1].slots[k];
      acc += Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    t.push(t[i] + acc / n);
  }
  rows.forEach((r, i) => { r.u = i === rows!.length - 1 ? 1 : t[i] / t[t.length - 1]; });
  // One sampling map per station. (Extra maps between stations were tried:
  // with 1-3 per interval the head -> stem maps differ so much that the iso-v
  // lines slide along the girth and fold, 6-9 deg faces; the station maps are
  // the smooth choice.)
  const maps = rows.map((r) => buildSampleMap(rows!, r.u, r.tKnots));
  rows.forEach((r, i) => { r.girthKnots = maps[i].slotV; });
  SAMPLE_MAP_CACHE.set(rows, maps);
  SPLINE_CACHE.set(profile, rows);
  return rows;
}

/** The v -> t sampling map at u, measured on G: v is the blend
 *  of arc length and SURFACE-NORMAL path turning down the girth (the normal of
 *  G turns where the section bends AND where the lines twist into the keel at
 *  the forefoot, which the section's own tangent never sees). The slots' t
 *  are map knots, so girthKnots[k] = v of slot k exactly. */
function buildSampleMap(rows: SplineRow[], u: number, V: number[]): SampleMap {
  const ts: number[] = [];
  const slotAt: number[] = [];
  for (let k = 0; k < V.length - 1; k++) {
    slotAt.push(ts.length);
    for (let j = 0; j < GIRTH_SAMPLE_DENSE; j++) ts.push(V[k] + (V[k + 1] - V[k]) * (j / GIRTH_SAMPLE_DENSE));
  }
  slotAt.push(ts.length);
  ts.push(1);
  const arc = [0], turn = [0];
  let prev = surfaceAt(rows, u, ts[0]);
  for (let j = 1; j < ts.length; j++) {
    const s = surfaceAt(rows, u, ts[j]);
    arc.push(arc[j - 1] + Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z));
    turn.push(turn[j - 1] + Math.acos(clamp(s.nx * prev.nx + s.ny * prev.ny + s.nz * prev.nz, -1, 1)));
    prev = s;
  }
  const A = arc[arc.length - 1] || 1, T = turn[turn.length - 1];
  const beta = T > 1e-6 ? GIRTH_TURN_WEIGHT : 0;
  const mv = ts.map((_, j) => ((1 - beta) * arc[j] / A + (beta > 0 ? beta * turn[j] / T : 0)) * (1 - 1e-6) + 1e-6 * j / (ts.length - 1));
  mv[mv.length - 1] = 1;
  return { u, mv, mt: ts, mm: pchipSlopes(mv, ts), slotV: slotAt.map((j) => mv[j]) };
}

/** Point + d/dv on one station's girth curve: [x, y, z, dx, dy, dz]. */
function rowAt(r: SplineRow, v: number, out: number[]): void {
  const [sv, ds] = pchipEval(r.vk, r.sk, r.sm, v);
  const x = pchipEval(r.g0, r.cx, r.mx, sv);
  const y = pchipEval(r.g0, r.cy, r.my, sv);
  const z = pchipEval(r.g0, r.cz, r.mz, sv);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0];
  out[3] = x[1] * ds; out[4] = y[1] * ds; out[5] = z[1] * ds;
}

const ROW_BUF = [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0, 0]);

/** Catmull-Rom tangent at knot k (1 or 2 of the 4-point window) for channel c
 *  and its v-derivative (channel c + 3). With `monotone`, the tangent is held
 *  in [0, 3·min(adjacent secants)] (Fritsch-Carlson): z must climb from stern
 *  to stem on every girth line, and at the forefoot the keel rises 0.4 draft
 *  over 0.01 L, where an unlimited Catmull-Rom loops back on itself. The limit
 *  is a function of the same two secants on both sides of a knot, so the
 *  curve stays C1. */
function crTangentAt(q: number[][], uu: number[], k: number, c: number, monotone: boolean): [number, number] {
  const ha = uu[k] - uu[k - 1], hb = uu[k + 1] - uu[k], hab = uu[k + 1] - uu[k - 1];
  const sa = (q[k][c] - q[k - 1][c]) / ha, sb = (q[k + 1][c] - q[k][c]) / hb;
  const dsa = (q[k][c + 3] - q[k - 1][c + 3]) / ha, dsb = (q[k + 1][c + 3] - q[k][c + 3]) / hb;
  let m = sa - (q[k + 1][c] - q[k - 1][c]) / hab + sb;
  let dm = dsa - (q[k + 1][c + 3] - q[k - 1][c + 3]) / hab + dsb;
  if (monotone) {
    const lim = 3 * Math.min(sa, sb);
    const dlim = 3 * (sa <= sb ? dsa : dsb);
    if (lim <= 0 || m <= 0) { m = 0; dm = 0; } else if (m > lim) { m = lim; dm = dlim; }
  }
  return [m, dm];
}

function crTangents(q: number[][], uu: number[], c: number, monotone: boolean, out: number[]): void {
  const a = crTangentAt(q, uu, 1, c, monotone), b = crTangentAt(q, uu, 2, c, monotone);
  out[0] = a[0]; out[1] = b[0]; out[2] = a[1]; out[3] = b[1];
}

/**
 * THE HULL SURFACE — point and outward normal anywhere on the starboard shell.
 * u: 0 transom edge → 1 stem line (centripetal knots, not z); v: 0 sheer → 1
 * keel. Mirror x/nx for port. Use hullSplineUAtZ to ask "where is z".
 *
 * Consumers (b4.2c onward): the renderer shell at tier resolution (LOD0 72 x
 * 40, < 5 deg between girth faces over the whole shell, bow included), the
 * waterline outline and contact chain (server), hull sockets for the
 * Blender kit (b4.3c). Nothing reads it yet: graded by
 * scripts/test-hull-spline-parity.mjs.
 */
export function sampleHullSurface(profile: HullProfile, u: number, v: number): HullSurfaceSample {
  const rows = getSplineRows(profile);
  const maps = SAMPLE_MAP_CACHE.get(rows)!;
  const uc = clamp(u, 0, 1), vc = clamp(v, 0, 1);
  let i = 0;
  while (i < maps.length - 2 && uc > maps[i + 1].u) i++;
  const a = maps[i], b = maps[i + 1];
  const tau = clamp((uc - a.u) / (b.u - a.u), 0, 1);
  const w = tau * tau * (3 - 2 * tau);
  const ta = pchipEval(a.mv, a.mt, a.mm, vc)[0], tb = pchipEval(b.mv, b.mt, b.mm, vc)[0];
  return surfaceAt(rows, uc, w <= 0 ? ta : w >= 1 ? tb : ta + (tb - ta) * w);
}

/** G(u, t): the lofted surface on its geometry parameter t (arc length inside
 *  each slot interval, slot k at tKnots[k]). */
function surfaceAt(rows: SplineRow[], u: number, t: number): HullSurfaceSample {
  const uc = clamp(u, 0, 1), vc = clamp(t, 0, 1);
  const last = rows.length - 1;
  let i = 0;
  while (i < last - 1 && uc > rows[i + 1].u) i++;
  // Q[i-1 .. i+2] at this v, reflected phantoms past the ends.
  const q = ROW_BUF;
  const uu = [0, 0, 0, 0];
  for (let s = 0; s < 4; s++) {
    const idx = i - 1 + s;
    if (idx >= 0 && idx <= last) { rowAt(rows[idx], vc, q[s]); uu[s] = rows[idx].u; }
  }
  // Phantoms: reflected points give the end knot its secant tangent.
  if (i === 0) { for (let c = 0; c < 6; c++) q[0][c] = 2 * q[1][c] - q[2][c]; uu[0] = 2 * uu[1] - uu[2]; }
  if (i + 2 > last) { for (let c = 0; c < 6; c++) q[3][c] = 2 * q[2][c] - q[1][c]; uu[3] = 2 * uu[2] - uu[1]; }
  const h = uu[2] - uu[1];
  const tt = clamp((uc - uu[1]) / h, 0, 1);
  const t2 = tt * tt, t3 = t2 * tt;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + tt, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const d00 = (6 * t2 - 6 * tt) / h, d10 = 3 * t2 - 4 * tt + 1, d01 = (-6 * t2 + 6 * tt) / h, d11 = 3 * t2 - 2 * tt;
  const p = [0, 0, 0, 0, 0, 0], du = [0, 0, 0];
  const tan = [0, 0, 0, 0];
  for (let c = 0; c < 3; c++) {
    // Non-uniform Catmull-Rom tangents (Barry-Goldman in Hermite form) for the
    // position channel c and its v-derivative channel c + 3.
    crTangents(q, uu, c, c === 2, tan);
    const [m1, m2, dm1, dm2] = tan;
    p[c] = h00 * q[1][c] + h10 * h * m1 + h01 * q[2][c] + h11 * h * m2;
    p[c + 3] = h00 * q[1][c + 3] + h10 * h * dm1 + h01 * q[2][c + 3] + h11 * h * dm2;
    du[c] = d00 * q[1][c] + d10 * m1 + d01 * q[2][c] + d11 * m2;
  }
  // Outward normal = dP/du × dP/dv (u toward the bow, v down the girth).
  let nx = du[1] * p[5] - du[2] * p[4];
  let ny = du[2] * p[3] - du[0] * p[5];
  let nz = du[0] * p[4] - du[1] * p[3];
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return { x: p[0], y: p[1], z: p[2], nx, ny, nz };
}

/** The spline's station table (loft rows + counter, flare, stem) with each
 *  row's u knot and girth knots. Read-only; for gates and socket placement. */
export function getHullSplineStations(profile: HullProfile): ReadonlyArray<HullSplineStation> {
  return getSplineRows(profile);
}

/** u at which the iso-v line of the spline reaches local z (bisection; z is
 *  strictly increasing in u, graded). Clamped to the hull's ends. */
export function hullSplineUAtZ(profile: HullProfile, z: number, v: number): number {
  let lo = 0, hi = 1;
  if (z <= sampleHullSurface(profile, 0, v).z) return 0;
  if (z >= sampleHullSurface(profile, 1, v).z) return 1;
  for (let it = 0; it < 52; it++) {
    const mid = (lo + hi) * 0.5;
    if (sampleHullSurface(profile, mid, v).z < z) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Geometry girth t on one spline row where the row's height is y (y falls
 *  monotonically sheer -> keel: PCHIP keeps the slots' order). Clamped to the
 *  row's sheer and keel. */
function rowTAtY(r: SplineRow, y: number): number {
  const out = [0, 0, 0, 0, 0, 0];
  rowAt(r, 0, out);
  if (y >= out[1]) return 0;
  rowAt(r, 1, out);
  if (y <= out[1]) return 1;
  let lo = 0, hi = 1;
  for (let it = 0; it < 48; it++) {
    const mid = (lo + hi) * 0.5;
    rowAt(r, mid, out);
    if (out[1] > y) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** The surface point G(u, t) with local z and y: damped 2D Newton on (u, t),
 *  finite-difference Jacobian, box-clamped (a pinned coordinate leaves the
 *  other to solve its own equation). The start is a fixed function of (z, y),
 *  so server and client get the same bits. */
function solveHullZY(rows: SplineRow[], z: number, y: number): HullSurfaceSample {
  // Start: t from the midship row's height, u from the knot z on that girth line.
  const mid = rows[Math.floor(rows.length / 2)];
  let t = rowTAtY(mid, y);
  const out = [0, 0, 0, 0, 0, 0];
  let u = 0;
  let prevZ = 0;
  for (let i = 0; i < rows.length; i++) {
    rowAt(rows[i], t, out);
    if (i === 0 && z <= out[2]) { u = 0; break; }
    if (i > 0 && z <= out[2]) { u = rows[i - 1].u + (rows[i].u - rows[i - 1].u) * clamp((z - prevZ) / Math.max(1e-9, out[2] - prevZ), 0, 1); break; }
    prevZ = out[2];
    u = 1;
  }
  const H = 1e-6;
  let s = surfaceAt(rows, u, t);
  for (let it = 0; it < 40; it++) {
    const ez = s.z - z, ey = s.y - y;
    if (Math.abs(ez) < 1e-9 && Math.abs(ey) < 1e-9) break;
    const hu = u + H <= 1 ? H : -H, ht = t + H <= 1 ? H : -H;
    const su = surfaceAt(rows, u + hu, t), st = surfaceAt(rows, u, t + ht);
    const zu = (su.z - s.z) / hu, yu = (su.y - s.y) / hu;
    const zt = (st.z - s.z) / ht, yt = (st.y - s.y) / ht;
    const det = zu * yt - zt * yu;
    let du = Math.abs(det) > 1e-12 ? -(ez * yt - zt * ey) / det : -ez / (zu || 1);
    let dt = Math.abs(det) > 1e-12 ? -(zu * ey - ez * yu) / det : -ey / (yt || -1);
    const big = Math.max(Math.abs(du), Math.abs(dt));
    if (big > 0.25) { du *= 0.25 / big; dt *= 0.25 / big; }
    let un = u + du, tn = t + dt;
    const uOut = un < 0 || un > 1, tOut = tn < 0 || tn > 1;
    if (uOut && !tOut) { un = clamp(un, 0, 1); tn = clamp(t - (ey + yu * (un - u)) / (yt || -1), 0, 1); }
    else if (tOut && !uOut) { tn = clamp(tn, 0, 1); un = clamp(u - (ez + zt * (tn - t)) / (zu || 1), 0, 1); }
    else { un = clamp(un, 0, 1); tn = clamp(tn, 0, 1); }
    if (Math.abs(un - u) < 1e-13 && Math.abs(tn - t) < 1e-13) break;
    u = un; t = tn;
    s = surfaceAt(rows, u, t);
  }
  return s;
}

// ─── DERIVED FOOTPRINTS (LOFT-01 phase 2) ────────────────────────────────────

const WATERLINE_OUTLINE_CACHE = new Map<ShipType, ReadonlyArray<{ zF: number; halfF: number }>>();

/**
 * THE WATERLINE OUTLINE — half-beam at every loft station, taken at y = 0.
 * This is the line the renderer draws meeting the sea, so it is the line the
 * seabed has to be measured against: the server used to ask about a strip one
 * metre wide down the keel and let cliff faces pass through ten metres of
 * planking either side of it (physics-02).
 *
 * Returned as FRACTIONS (zF of length, halfF of beam) so a caller scales two
 * multiplies per sample instead of walking the profile. Cached per class; the
 * array is frozen because the server iterates it every tick.
 *
 * Consumers: `PhysicsSystem.pushShipOutOfIsland` (server) via
 * `scripts/test-hull-vs-terrain.mjs`; the client reads the same loft through
 * `getHullProfile` in ShipRenderer, so drawn and collided agree by construction.
 */
export function getHullWaterlineOutline(type: ShipType): ReadonlyArray<{ zF: number; halfF: number }> {
  let outline = WATERLINE_OUTLINE_CACHE.get(type);
  if (outline) return outline;
  const profile = getHullProfile(type);
  const rows = getSplineRows(profile);
  const out = [0, 0, 0, 0, 0, 0];
  outline = Object.freeze(rows.map((r) => {
    rowAt(r, rowTAtY(r, 0), out);
    return { zF: out[2] / profile.L, halfF: Math.max(0, out[0]) / profile.W };
  }));
  WATERLINE_OUTLINE_CACHE.set(type, outline);
  return outline;
}

/** Widest half-breadth of the hull's z-section (max x over every height at
 *  local z): a scan in y on the spline, then golden section on the best bracket. */
function sectionHalfBreadth(rows: SplineRow[], z: number): number {
  let yLo = Infinity, yHi = -Infinity;
  for (const r of rows) { yLo = Math.min(yLo, r.slots[r.slots.length - 1].y); yHi = Math.max(yHi, r.slots[0].y); }
  const N = 48;
  const xAt = (y: number) => solveHullZY(rows, z, y).x;
  let bestJ = 0, bestX = -Infinity;
  for (let j = 0; j <= N; j++) { const x = xAt(yLo + (yHi - yLo) * (j / N)); if (x > bestX) { bestX = x; bestJ = j; } }
  let lo = yLo + (yHi - yLo) * Math.max(0, bestJ - 1) / N, hi = yLo + (yHi - yLo) * Math.min(N, bestJ + 1) / N;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 32; it++) {
    const c = hi - g * (hi - lo), d = lo + g * (hi - lo);
    if (xAt(c) >= xAt(d)) hi = d; else lo = c;
  }
  return Math.max(bestX, xAt((lo + hi) * 0.5));
}

const CONTACT_CHAIN_CACHE = new Map<ShipType, ReadonlyArray<{ zF: number; halfF: number }>>();

/**
 * THE CONTACT CHAIN — the capsule chain two hulls, a reef and a pier are
 * resolved against. `halfF` is the MAXIMUM half-beam of the section at that
 * station, i.e. the wale, because the wale is the widest timber on the ship
 * and the widest timber is what rubs, what a rock stops and what a pier hits.
 *
 * It used to be a hand-kept table (`HULL_CONTACT_STATIONS`, max 0.52 W) plus a
 * SECOND hand-kept table for sea rocks (max 0.68 W offset+radius) that was
 * WIDER than the ship. So rocks stopped a galleon 2.8 m short of touching her
 * while rammed galleons interpenetrated 1.9 m — both hulls sank 0.096 W of
 * their real beam into each other (ships-24, physics-20/08/12/40).
 *
 * Consumers: `PhysicsSystem.getShipHullContactSamples` → ship-ship, dock and
 * sea-rock resolution (server), graded by scripts/test-ship-dynamics.mjs,
 * test-sea-rock-ship-damage.mjs and test-sea-rock-colliders.mjs. No client path
 * reads it; the client draws the same loft through `getHullProfile`.
 */
export function getHullContactChain(type: ShipType): ReadonlyArray<{ zF: number; halfF: number }> {
  let chain = CONTACT_CHAIN_CACHE.get(type);
  if (chain) return chain;
  const profile = getHullProfile(type);
  const rows = getSplineRows(profile);
  const out = [0, 0, 0, 0, 0, 0];
  chain = Object.freeze(rows.map((r) => {
    // The row's widest point says WHERE along the length this capsule sits;
    // its radius is the widest the hull is at that z over every height (the
    // z-section, not the row: near the raked transom a z-section cuts the
    // counter forward of the row and is 0.4 m wider on a galleon).
    const N = 192;
    let bestX = -Infinity, bestZ = 0, bestAbs = -Infinity;
    for (let j = 0; j <= N; j++) {
      rowAt(r, j / N, out);
      // A plateau (the stem head's sheer, upper strake and wale share one
      // half-breadth; the stem line is sided constant) takes its point
      // farthest from midships, the end that strikes.
      if (out[0] > bestX + 1e-6 || (out[0] >= bestX - 1e-6 && Math.abs(out[2]) > bestAbs)) {
        if (out[0] > bestX) bestX = out[0];
        bestZ = out[2]; bestAbs = Math.abs(out[2]);
      }
    }
    return { zF: bestZ / profile.L, halfF: sectionHalfBreadth(rows, bestZ) / profile.W };
  }));
  CONTACT_CHAIN_CACHE.set(type, chain);
  return chain;
}

/** THE RIG PLAN (ships-02, b4.2f) — the ONE set of rig numbers. The renderer
 *  (ship/sails.ts buildRig, the LOD1/LOD2/far variants), the crow's nest and
 *  its ladder (getCrowNestStandingY), and the server's chainshot band
 *  (isPointInRiggingCanvas) all read this, so what you see aloft is what a
 *  chain connects with.
 *
 *  Proportions (period practice, read at range as a sailing ship):
 *  - main truck above the deck / LOA: sloop 1.10, brigantine 1.00, galleon
 *    0.92 (RIG_TRUCK_PER_LOA by mast count); the galleon mizzen 0.84 of that.
 *  - yards 1.5-1.8 x beam: a course yard 1.8 W on the fore, 0.1 W less per
 *    mast aft (the sloop's single course 1.7 W), every topsail yard 1.5 W.
 *  - two square sails per mast on the brigantine and galleon (course + topsail;
 *    the topsail furls first, sailHoistFor), one big course on the sloop, and a
 *    gaff spanker abaft the brigantine's aft mast.
 *  - every course foot (and the spanker boom) at least COURSE_FOOT_ABOVE_
 *    QUARTERDECK above the raised quarterdeck, so the helmsman sees under the
 *    canvas; the renderer also fades courses to 35% for the local helmsman's
 *    first-person view only.
 *
 *  All y values are SHIP-LOCAL (deck = stats.height, waterline = 0). */
export const RIG_TRUCK_PER_LOA = [1.10, 1.00, 0.92] as const;
/** Mizzen (third mast) height as a fraction of the main. */
export const RIG_MIZZEN_HEIGHT = 0.84;
export const RIG_COURSE_YARD_PER_BEAM = 1.8;
export const RIG_SLOOP_COURSE_YARD_PER_BEAM = 1.7;
export const RIG_TOPSAIL_YARD_PER_BEAM = 1.5;
/** Course yard / topsail yard heights as a fraction of that mast's height above
 *  the deck. The crow's nest rides at 0.86, just above the top yard. */
export const RIG_COURSE_YARD_AT = 0.5;
export const RIG_TOP_YARD_AT = 0.8;
/** Must equal getShipQuarterdeckConfig(stats).rise (graded by test-ship-rigging). */
export const RIG_QUARTERDECK_RISE = 0.45;
export const COURSE_FOOT_ABOVE_QUARTERDECK = 2.4;
/** Canvas width as a fraction of its yard (the yardarms overhang the sail). */
export const RIG_CANVAS_PER_YARD = 0.92;
/** Course opacity for the local helmsman's first-person view only. */
export const HELM_COURSE_FADE = 0.35;

export type RigSailKind = 'course' | 'topsail' | 'spanker';
export interface RigSail {
  kind: RigSailKind;
  /** Head of the canvas (the yard, or the gaff peak), ship-local y. */
  headY: number;
  /** Foot of the canvas fully set, ship-local y. */
  footY: number;
  /** Yard half-length (square sails) or half the spanker's thickness band. */
  halfSpan: number;
  /** Canvas width at the head and at the foot (a topsail tapers to its head). */
  headW: number;
  footW: number;
  /** Fore and aft extent of the canvas, ship-local z. */
  zFore: number;
  zAft: number;
}
export interface RigMast {
  z: number;
  /** Mast height above the deck; the truck is at stats.height + height. */
  height: number;
  truckY: number;
  sails: RigSail[];
}

/** Mast height above the deck of the MAIN (the nest mast): LOA x truck ratio. */
export function getMastHeight(stats: { length: number; mastCount: number }): number {
  const ratio = RIG_TRUCK_PER_LOA[Math.min(Math.max(stats.mastCount, 1), 3) - 1];
  return stats.length * ratio;
}

/** Where a set sail of this kind stands for a ship sail height 0..1: the
 *  topsail goes away first (it is fully in by sailHeight 0.35), the course and
 *  spanker follow sailHeight directly. */
export function sailHoistFor(kind: RigSailKind, sailHeight: number): number {
  const h = Math.min(1, Math.max(0, sailHeight));
  return kind === 'topsail' ? Math.min(1, Math.max(0, (h - 0.35) / 0.65)) : h;
}

export function getShipRigPlan(
  stats: { width: number; length: number; height: number; mastCount: number },
): RigMast[] {
  const H = stats.height, L = stats.length, W = stats.width;
  const n = stats.mastCount;
  // Layout unchanged: the fore at 0.28 L, the aftmost 0.42 L behind it, still
  // forward of the helm (wheel at -0.315 L).
  const spacing = L * 0.42 / Math.max(n - 1, 1);
  const main = getMastHeight(stats);
  const courseFootY = H + RIG_QUARTERDECK_RISE + COURSE_FOOT_ABOVE_QUARTERDECK;
  const masts: RigMast[] = [];
  for (let m = 0; m < n; m++) {
    const z = L * 0.28 - m * spacing;
    const height = main * (m >= 2 ? RIG_MIZZEN_HEIGHT : 1);
    const sails: RigSail[] = [];
    if (n === 1) {
      const yard = W * RIG_SLOOP_COURSE_YARD_PER_BEAM;
      sails.push({
        kind: 'course', headY: H + height * RIG_TOP_YARD_AT, footY: courseFootY, halfSpan: yard * 0.5,
        headW: yard * RIG_CANVAS_PER_YARD, footW: yard * RIG_CANVAS_PER_YARD, zFore: z + 0.4, zAft: z - 0.4,
      });
    } else {
      const course = W * (RIG_COURSE_YARD_PER_BEAM - 0.1 * m);
      const top = W * RIG_TOPSAIL_YARD_PER_BEAM;
      const courseYardY = H + height * RIG_COURSE_YARD_AT;
      sails.push({
        kind: 'course', headY: courseYardY, footY: courseFootY, halfSpan: course * 0.5,
        headW: course * RIG_CANVAS_PER_YARD, footW: course * RIG_CANVAS_PER_YARD, zFore: z + 0.4, zAft: z - 0.4,
      });
      sails.push({
        kind: 'topsail', headY: H + height * RIG_TOP_YARD_AT, footY: courseYardY + 0.3, halfSpan: top * 0.5,
        headW: top * RIG_CANVAS_PER_YARD, footW: course * 0.88, zFore: z + 0.4, zAft: z - 0.4,
      });
      if (n === 2 && m === n - 1) {
        // Gaff spanker abaft the brigantine's aft mast: boom at the course
        // foot (over the helmsman's head), gaff peak at 0.62 of the mast.
        const boom = L * 0.17;
        sails.push({
          kind: 'spanker', headY: H + height * 0.62, footY: courseFootY, halfSpan: 0.5,
          headW: L * 0.13, footW: boom, zFore: z - 0.1, zAft: z - 0.1 - boom,
        });
      }
    }
    masts.push({ z, height, truckY: H + height, sails });
  }
  return masts;
}

/** Per-mast canvas boxes (z, widest half-span, fore-aft half-depth) — the
 *  coarse broad phase; the exact test is isPointInRiggingCanvas. */
export function getShipRiggingMasts(
  stats: { width: number; length: number; height: number; mastCount: number },
): Array<{ z: number; halfWidth: number; halfDepth: number }> {
  const spacing = stats.length * 0.42 / Math.max(stats.mastCount - 1, 1);
  const band = Math.max(spacing * 0.5, stats.length * 0.22);
  return getShipRigPlan(stats).map((mast) => {
    let halfWidth = 0, fore = mast.z + band, aft = mast.z - band;
    for (const s of mast.sails) {
      halfWidth = Math.max(halfWidth, s.kind === 'spanker' ? s.halfSpan : Math.max(s.headW, s.footW) * 0.5);
      fore = Math.max(fore, s.zFore); aft = Math.min(aft, s.zAft);
    }
    return { z: mast.z, halfWidth, halfDepth: Math.max(fore - mast.z, mast.z - aft) };
  });
}

/** THE CHAINSHOT BAND: is a ship-local point inside set canvas? Each sail is
 *  its own box: across, its canvas half-width (a metre outboard of the
 *  yardarm is sky); vertically, from its head down to its foot as hoisted
 *  (sailHoistFor; a half-set course hangs half as deep, a furled sail is spars
 *  and air); fore-and-aft, a generous band either side of the mast for the
 *  belly, stays and shrouds (0.22 L or half the mast spacing), the spanker its
 *  own boom length. `set` is sailHeight x sailIntegrity. */
export function isPointInRiggingCanvas(
  stats: { width: number; length: number; height: number; mastCount: number },
  local: { x: number; y: number; z: number },
  set: number,
): boolean {
  const spacing = stats.length * 0.42 / Math.max(stats.mastCount - 1, 1);
  const halfDepth = Math.max(spacing * 0.5, stats.length * 0.22);
  for (const mast of getShipRigPlan(stats)) {
    for (const s of mast.sails) {
      const hoist = sailHoistFor(s.kind, set);
      if (hoist <= 0.06) continue;
      const lowY = s.headY - (s.headY - s.footY) * hoist;
      if (local.y < lowY || local.y > s.headY) continue;
      if (s.kind === 'spanker') {
        if (Math.abs(local.x) <= s.halfSpan && local.z <= s.zFore && local.z >= s.zAft) return true;
        continue;
      }
      if (Math.abs(local.x) <= Math.max(s.headW, s.footW) * 0.5 && Math.abs(local.z - mast.z) <= halfDepth) return true;
    }
  }
  return false;
}
