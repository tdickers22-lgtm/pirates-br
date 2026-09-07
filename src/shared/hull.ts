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
  { zf:  0.50, dh: 0.055, sheer: 1.08,  keel01: 0.18, wlF: 0.30, bilgeF: 0.14, mid: 0.00, ztF:  0.530, zbF:  0.415 },
];

const HULL_PROFILE_CACHE = new Map<ShipType, HullProfile>();

export function getHullProfile(type: ShipType): HullProfile {
  let profile = HULL_PROFILE_CACHE.get(type);
  if (profile) return profile;
  const stats = SHIP_STATS[type];
  const { bulge, draftF } = HULL_SHAPES[type];
  const W = stats.width, H = stats.height, L = stats.length;
  const draft = H * draftF;
  const stations: HullProfileStation[] = LOFT_STATIONS.map((def) => {
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
  });
  profile = { W, H, L, draft, stations };
  HULL_PROFILE_CACHE.set(type, profile);
  return profile;
}

/** Hull texture V for a local height — the whole shell (keel → highest sheer)
 *  maps 0..1 so the painted waterline/wale bands land on the right planks. */
export function hullUvV(profile: HullProfile, y: number): number {
  return clamp((y + profile.draft) / (profile.H * 1.08 + profile.draft), 0, 1);
}

/** Interpolates one station's side polyline at height y. Returns surface x, the
 *  outward 2D section normal (starboard sense) and the raked z at that height. */
export function stationSurfaceAt(st: HullProfileStation, y: number): { x: number; z: number; nx: number; ny: number } {
  const slots = st.slots;
  let j = 0;
  const yc = clamp(y, slots[slots.length - 1].y, slots[0].y);
  while (j < slots.length - 2 && yc < slots[j + 1].y) j++;
  const a = slots[j], b = slots[j + 1];
  const t = clamp((a.y - yc) / Math.max(0.0001, a.y - b.y), 0, 1);
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  // Outward normal of segment a→b (downward), rotated +90°: (Δy, Δx_down)
  let nx = a.y - b.y;
  let ny = b.x - a.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  return { x, z, nx, ny };
}

/** Surface point + outward section normal anywhere on the loft (starboard side;
 *  mirror x/nx for port). Used to anchor gunports, rivets and hole decals. */
export function hullSurfacePointAt(profile: HullProfile, z: number, y: number): { x: number; nx: number; ny: number } {
  const sts = profile.stations;
  const zc = clamp(z, sts[0].baseZ, sts[sts.length - 1].baseZ);
  let i = 0;
  while (i < sts.length - 2 && zc > sts[i + 1].baseZ) i++;
  const a = sts[i], b = sts[i + 1];
  const t = clamp((zc - a.baseZ) / Math.max(0.0001, b.baseZ - a.baseZ), 0, 1);
  const sa = stationSurfaceAt(a, y);
  const sb = stationSurfaceAt(b, y);
  let nx = sa.nx + (sb.nx - sa.nx) * t;
  let ny = sa.ny + (sb.ny - sa.ny) * t;
  const len = Math.hypot(nx, ny) || 1;
  return { x: sa.x + (sb.x - sa.x) * t, nx: nx / len, ny: ny / len };
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
  outline = Object.freeze(profile.stations.map((st) => ({
    zF: st.baseZ / profile.L,
    halfF: hullSurfacePointAt(profile, st.baseZ, 0).x / profile.W,
  })));
  WATERLINE_OUTLINE_CACHE.set(type, outline);
  return outline;
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
  chain = Object.freeze(profile.stations.map((st) => {
    let widest = 0;
    for (const slot of st.slots) if (slot.x > widest) widest = slot.x;
    return { zF: st.baseZ / profile.L, halfF: widest / profile.W };
  }));
  CONTACT_CHAIN_CACHE.set(type, chain);
  return chain;
}
