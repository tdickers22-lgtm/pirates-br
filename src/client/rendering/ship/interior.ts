// THE HOLD — floor, inner skin, bulkheads, ribs, beams, hammocks, crates and
// the cargo stacks below the weather deck. Extracted verbatim from ShipRenderer
// (codehealth-03 phase 1, HULLGEO-01 slice a);
// scripts/test-ship-geometry-hash.mjs pins the move.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { registerBudgetLight } from '../LightBudget.js';
import { getShipHoldHalfWidth } from '../../../shared/interactions.js';
import { hullSurfacePointAt, stationSurfaceAt } from '../../../shared/hull.js';
import type { HullProfile } from '../../../shared/hull.js';
import { acquireSharedGeometry, makeLoftedSlabGeometry, makeSheerRunGeometry } from './geometry.js';

/** Hold floor top = the plane the server stands crew on (SHIP.HOLD_FLOOR_OFFSET). */
export const HOLD_FLOOR_Y = 0.35;
/** Fore-and-aft half-length of the hold, matching isInsideShipHoldFootprint. */
export const HOLD_HALF_LENGTH_F = 0.34;
/** Thickness of the drawn inner skin (the lining runs outboard of holdHalfWidthAt). */
export const HOLD_LINING_THICKNESS = 0.14;
/** How far OUTBOARD of the walk clamp the drawn inner skin sits. The gate wants
 *  3-12 cm: closer and a pirate clips through her own bulkhead, further and the
 *  hold has an invisible wall short of the timber you can see. */
const HOLD_SKIN_MARGIN = 0.06;

/**
 * THE HOLD'S OUTLINE, and why it is a min() of two things.
 *
 * The hold was a rectangle: floor W.0.88 x L.0.88, walls at 0.42 W, bulkheads
 * at 0.39 L. The hull is a loft and the walk footprint is a taper, so all three
 * disagreed with both: on a galleon 24 of 24 floor corners sat up to 4.2 m
 * outside the planking (the floor stuck through the bow), while the server's
 * clamp stopped a pirate 1.1 m short of the bulkhead she could see (ships-04,
 * liveplay-09).
 *
 * So the drawn skin is the walk footprint plus HOLD_SKIN_MARGIN — except where
 * the planking arrives first, at the very ends of the taper, where the hull
 * wins and the last few centimetres of footprint are inside timber.
 */
export function holdHalfWidthAt(
  stats: { width: number; length: number },
  profile: HullProfile,
  z: number,
): number {
  const footprint = getShipHoldHalfWidth(stats, z) + HOLD_SKIN_MARGIN;
  const planking = hullSurfacePointAt(profile, z, HOLD_FLOOR_Y + 0.02).x - 0.09;
  return Math.max(0.2, Math.min(footprint, planking));
}

/** The low angled bilge boards (one per side): 0.16 m thick, 0.34 H tall,
 *  centred 0.24 m inboard of holdHalfWidthAt(0) at y 0.52, top leaning outboard
 *  by 0.12 pi. Shared with ShipRenderer's breach seat (holes-06): above the sole
 *  the board, not the lining, is what a crewmate sees in front of a breach. */
const BILGE_BOARD_THICK = 0.16;
const BILGE_BOARD_H_F = 0.34;
const BILGE_BOARD_INSET = 0.24;
const BILGE_BOARD_Y = 0.52;
const BILGE_BOARD_TILT = Math.PI * 0.12;
export const BILGE_BOARD_LEN_F = 0.9;

/**
 * The bilge board's INBOARD face at height y on one side: hull-local x and the
 * face's inboard normal (nx, ny). null where the board does not reach that
 * height. The board runs 0.9 of the hold length at one constant x.
 */
export function bilgeBoardInboardFaceAt(
  stats: { width: number; length: number; height: number },
  profile: HullProfile,
  side: -1 | 1,
  y: number,
): { x: number; nx: number; ny: number } | null {
  const c = Math.cos(BILGE_BOARD_TILT), s = Math.sin(BILGE_BOARD_TILT);
  const half = BILGE_BOARD_THICK * 0.5;
  // Board-local v (along its height) where the inboard face crosses y.
  const v = (y - BILGE_BOARD_Y - half * s) / c;
  if (Math.abs(v) > stats.height * BILGE_BOARD_H_F * 0.5) return null;
  const cx = holdHalfWidthAt(stats, profile, 0) - BILGE_BOARD_INSET;
  return { x: side * (cx - half * c + v * s), nx: -side * c, ny: s };
}

/**
 * THE INNER PLANKING (ships-10, b2.3e). The hold used to be a box: flat walls
 * 0.4-2.5 m inboard of the hull, so from inside it read as a lit tunnel, not a
 * ship. Above the stowage lockers the visible skin is now the ceiling planking,
 * HOLD_CEILING_OFFSET inboard of the SHARED hull sampler (hullSurfacePointAt),
 * so whatever reshapes the loft (the b4 spline) carries the hold with it.
 * Horizontal offset: on these flared topsides |nx| >= 0.9, so the normal
 * distance stays inside 0.08-0.15 m (test-ship-geometry 2c).
 */
export const HOLD_CEILING_OFFSET = 0.12;
/** Frame (rib) spacing along the hold, metres. */
export const HOLD_FRAME_SPACING = 0.6;

/** Hull-local half-width of the ceiling planking's inboard face at (z, y). */
export function holdCeilingHalfAt(profile: HullProfile, z: number, y: number): number {
  return drawnShellHalfAt(profile, z, y) - HOLD_CEILING_OFFSET;
}

/** The DRAWN shell's half-width at (z, y): each station's surface point at y
 *  (shared stationSurfaceAt) carries its own RAKED z, and x is interpolated
 *  over those. hullSurfacePointAt interpolates over the base z instead, which
 *  near the sheer at the hold ends reads up to 5 cm narrower than the planking
 *  the renderer lofts (measured 0.172 m vs 0.12 on the galleon). */
function drawnShellHalfAt(profile: HullProfile, z: number, y: number): number {
  const sts = profile.stations;
  let prev = stationSurfaceAt(sts[0], y);
  if (z <= prev.z) return prev.x;
  for (let i = 1; i < sts.length; i++) {
    const cur = stationSurfaceAt(sts[i], y);
    if (z <= cur.z) {
      const t = (z - prev.z) / Math.max(1e-4, cur.z - prev.z);
      return prev.x + (cur.x - prev.x) * t;
    }
    prev = cur;
  }
  return prev.x;
}

/**
 * Top of the stowage lockers along both sides of the hold. The lining (the
 * walk wall 3-12 cm outboard of the server clamp) stops here and a lid runs
 * out to the ceiling planking, so the pirate is stopped by a locker front she
 * can see instead of by a wall 1-2 m short of the hull. Just above the angled
 * bilge board's top edge.
 */
export function holdLockerTopY(stats: { height: number }): number {
  const c = Math.cos(BILGE_BOARD_TILT), s = Math.sin(BILGE_BOARD_TILT);
  return BILGE_BOARD_Y + stats.height * BILGE_BOARD_H_F * 0.5 * c + BILGE_BOARD_THICK * 0.5 * s + 0.06;
}

/** Deck underside (bottom of the ceiling slabs) = top of the inner planking. */
function deckUndersideY(H: number): number { return H - 0.16; }

function addQuad(pos: number[], idx: number[], a: number[], b: number[], c: number[], d: number[], flip: boolean) {
  const base = pos.length / 3;
  pos.push(...a, ...b, ...c, ...d);
  if (flip) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function finishGeometry(pos: number[], idx: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) { uv[i * 2] = pos[i * 3 + 2] * 0.5; uv[i * 2 + 1] = pos[i * 3 + 1] * 0.5; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const ng = geo.toNonIndexed();
  ng.computeVertexNormals();
  geo.dispose();
  return ng;
}

/** Inner planking: strakes ~0.2 m tall with 12 mm seams (the seam shows the
 *  dark void behind), single-sided, facing inboard. */
function makeCeilingPlankingGeometry(profile: HullProfile, holdZ: number, y0: number, y1: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const strakes = Math.max(3, Math.round((y1 - y0) / 0.21));
  const sh = (y1 - y0) / strakes;
  const nz = Math.max(8, Math.ceil((holdZ * 2) / 0.5));
  for (const side of [-1, 1] as const) {
    for (let k = 0; k < strakes; k++) {
      const yb = y0 + k * sh + (k === 0 ? 0 : 0.006);
      const yt = y0 + (k + 1) * sh - (k === strakes - 1 ? 0 : 0.006);
      for (let i = 0; i < nz; i++) {
        const z0 = -holdZ + (i / nz) * holdZ * 2, z1 = -holdZ + ((i + 1) / nz) * holdZ * 2;
        const p = (z: number, y: number) => [side * holdCeilingHalfAt(profile, z, y), y, z];
        addQuad(pos, idx, p(z0, yb), p(z1, yb), p(z1, yt), p(z0, yt), side < 0);
      }
    }
  }
  return finishGeometry(pos, idx);
}

/** Frames every HOLD_FRAME_SPACING: 0.10 m sided, 0.09 m moulded, standing
 *  proud of the ceiling from the locker lid to the deck. One merged draw. */
function makeFrameGeometry(profile: HullProfile, holdZ: number, y0: number, y1: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const n = Math.floor((holdZ * 2 - 0.3) / HOLD_FRAME_SPACING);
  const z0 = -((n - 1) * HOLD_FRAME_SPACING) / 2;
  const rows = 5, sided = 0.05, moulded = 0.09;
  for (let f = 0; f < n; f++) {
    const fz = z0 + f * HOLD_FRAME_SPACING;
    for (const side of [-1, 1] as const) {
      for (let r = 0; r < rows; r++) {
        const ya = y0 + (r / rows) * (y1 - y0), yb = y0 + ((r + 1) / rows) * (y1 - y0);
        const xa = holdCeilingHalfAt(profile, fz, ya), xb = holdCeilingHalfAt(profile, fz, yb);
        const P = (x: number, y: number, z: number) => [side * x, y, z];
        // inboard face
        addQuad(pos, idx, P(xa - moulded, ya, fz - sided), P(xa - moulded, ya, fz + sided), P(xb - moulded, yb, fz + sided), P(xb - moulded, yb, fz - sided), side < 0);
        // fore and aft cheeks
        addQuad(pos, idx, P(xa, ya, fz + sided), P(xb, yb, fz + sided), P(xb - moulded, yb, fz + sided), P(xa - moulded, ya, fz + sided), side < 0);
        addQuad(pos, idx, P(xa, ya, fz - sided), P(xa - moulded, ya, fz - sided), P(xb - moulded, yb, fz - sided), P(xb, yb, fz - sided), side < 0);
      }
    }
  }
  return finishGeometry(pos, idx);
}

/** A hammock slung fore-and-aft: sagging cloth, curled edges. */
function makeHammockGeometry(len: number, width: number, sag: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(width, len, 4, 10);
  const pa = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), zl = pa.getY(i);
    const t = zl / (len * 0.5), u = x / (width * 0.5);
    const y = -sag * (1 - t * t) + 0.06 * u * u * (1 - t * t);
    pa.setXYZ(i, x * (0.35 + 0.65 * (1 - t * t)), y, zl);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A cargo net draped over a lump of stores: rope ribbons on a dome. */
function makeCargoNetGeometry(rx: number, rz: number, h: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const top = (x: number, z: number) => h * Math.max(0, 1 - (x / rx) ** 2 - (z / rz) ** 2) ** 0.5 + 0.01;
  const w = 0.014, lines = 6, seg = 10;
  for (let l = 0; l <= lines; l++) {
    const f = -1 + (2 * l) / lines;
    for (let k = 0; k < seg; k++) {
      const a = -1 + (2 * k) / seg, b = -1 + (2 * (k + 1)) / seg;
      // along z at x = f rx
      const xa = f * rx * 0.98, za = a * rz * Math.sqrt(Math.max(0, 1 - f * f)), zb = b * rz * Math.sqrt(Math.max(0, 1 - f * f));
      addQuad(pos, idx, [xa - w, top(xa, za), za], [xa + w, top(xa, za), za], [xa + w, top(xa, zb), zb], [xa - w, top(xa, zb), zb], true);
      // along x at z = f rz
      const zc = f * rz * 0.98, xa2 = a * rx * Math.sqrt(Math.max(0, 1 - f * f)), xb2 = b * rx * Math.sqrt(Math.max(0, 1 - f * f));
      addQuad(pos, idx, [xa2, top(xa2, zc), zc - w], [xb2, top(xb2, zc), zc - w], [xb2, top(xb2, zc), zc + w], [xa2, top(xa2, zc), zc + w], false);
    }
  }
  return finishGeometry(pos, idx);
}

/**
 * The lantern tints live in a 2x1 texel strip, not in vertex colours: a
 * vertex-coloured basic material linked a program of its own on every hull
 * (+1 on the phone's 70-program ceiling, b2 gate), while a mapped, untonemapped
 * basic program already exists in every scene. Texel 0 is the horn glass,
 * texel 1 the flame card, both the exact linear values the vertex colours
 * carried (quantised to 8 bits), sampled nearest at the texel centre.
 */
const LANTERN_TEXEL = { glass: 0.25, flame: 0.75 } as const;
let lanternTintTex: THREE.DataTexture | null = null;
function lanternTintTexture(): THREE.DataTexture {
  if (lanternTintTex) return lanternTintTex;
  const px = new Uint8Array([
    Math.round(0.42 * 255), Math.round(0.24 * 255), Math.round(0.07 * 255), 255,
    255, Math.round(0.72 * 255), Math.round(0.28 * 255), 255,
  ]);
  const tex = new THREE.DataTexture(px, 2, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  lanternTintTex = tex;
  return tex;
}
function tintGeometry(geo: THREE.BufferGeometry, u: number) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, 0.5);
  uv.needsUpdate = true;
}

export interface StairwellHole {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

export function makeShipInterior(
  stats: { width: number; length: number; height: number },
  woodMat: THREE.Material,
  darkMat: THREE.Material,
  hole: StairwellHole,
  profile: HullProfile,
  /** Only the lantern silhouettes read it: four radial sides instead of six. */
  quality: 'low' | 'balanced' | 'high' = 'balanced',
  /**
   * holes-06: the breach seen from INSIDE. The hull shader cut only the outer
   * skin; the lining 0.14 m inboard, the sole and the bilge boards covered it,
   * so from the hold a waterline breach showed no opening at all. ShipRenderer
   * passes its capsule discard (shell point -> inboard seat, same slots and
   * radius) and it is applied to exactly those three surfaces. Each gets its
   * OWN material so the cut never reaches deck timber that shares darkMat.
   */
  breachDiscard?: (material: THREE.Material) => void,
): THREE.Group {
  const g = new THREE.Group();
  const W = stats.width, L = stats.length, H = stats.height;
  const holdZ = L * HOLD_HALF_LENGTH_F;
  const holdHalf = (z: number) => holdHalfWidthAt(stats, profile, z);
  const ironMatShared = new THREE.MeshStandardMaterial({ color: 0x140f08, roughness: 0.75 });
  ironMatShared.name = 'hold-lantern-iron';

  // Hold floor — warmer brown with a touch of wood grain so it reads as an actual
  // floor (not a flat dark tarp) when the player peers down through the stairwell.
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x4a2e15, roughness: 0.85 });
  floorMat.name = 'hold-floor';
  breachDiscard?.(floorMat);
  const floor = new THREE.Mesh(
    makeLoftedSlabGeometry(profile, {
      topY: HOLD_FLOOR_Y, thickness: 0.12, zFrom: -holdZ, zTo: holdZ, samples: 14,
      halfAt: holdHalf,
    }),
    floorMat,
  );
  floor.receiveShadow = true;
  g.add(floor);

  // Inner walls (port/starboard)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 1 });
  wallMat.name = 'hold-inner-wall';
  breachDiscard?.(wallMat);
  const lockerTop = holdLockerTopY(stats);
  const deckUnder = deckUndersideY(H);
  const ceilAt = (z: number, y: number) => holdCeilingHalfAt(profile, z, y);
  // The lining is now the stowage-locker FRONT: it stops at the locker top and
  // a lid runs out to the inner planking (below).
  const wallH = lockerTop - 0.01 - HOLD_FLOOR_Y;
  for (const side of [-1, 1] as const) {
    const wall = new THREE.Mesh(
      makeSheerRunGeometry(profile, side, {
        y0: HOLD_FLOOR_Y, y1: HOLD_FLOOR_Y + wallH, thickness: HOLD_LINING_THICKNESS,
        zFrom: -holdZ, zTo: holdZ, samples: 12, halfAt: (z) => holdHalf(z) + HOLD_LINING_THICKNESS,
      }),
      wallMat,
    );
    g.add(wall);
  }

  // Locker lids: from the lining's top out to the inner planking, one lofted
  // strip per side (top + inboard edge). Stores, nets, stanchions and the
  // hammocks' lower reach live out here, outboard of the walk clamp.
  {
    const pos: number[] = [], idx: number[] = [];
    const nz = Math.max(8, Math.ceil((holdZ * 2) / 0.5));
    const yT = lockerTop + 0.05;
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < nz; i++) {
        const z0 = -holdZ + (i / nz) * holdZ * 2, z1 = -holdZ + ((i + 1) / nz) * holdZ * 2;
        // Front edge on the lining face, never inside the walk clamp's 3 cm
        // (where the planking wins at the taper ends the lining sits closer).
        const lidEdge = (z: number) => Math.max(holdHalf(z), getShipHoldHalfWidth(stats, z) + 0.04);
        const xi0 = lidEdge(z0), xi1 = lidEdge(z1);
        const xo0 = Math.max(xi0, ceilAt(z0, yT)), xo1 = Math.max(xi1, ceilAt(z1, yT));
        addQuad(pos, idx, [side * xi0, yT, z0], [side * xo0, yT, z0], [side * xo1, yT, z1], [side * xi1, yT, z1], side > 0);
        addQuad(pos, idx, [side * xi0, yT - 0.06, z0], [side * xi0, yT, z0], [side * xi1, yT, z1], [side * xi1, yT - 0.06, z1], side > 0);
      }
    }
    const lids = new THREE.Mesh(finishGeometry(pos, idx), wallMat);
    lids.name = 'hold-locker-lids';
    lids.receiveShadow = true;
    g.add(lids);
  }

  // Inner planking (ceiling) from the lids to the deck, on the hull sampler.
  // Same material as the sole (one draw, same breach cut).
  const ceiling = new THREE.Mesh(makeCeilingPlankingGeometry(profile, holdZ, lockerTop + 0.05, deckUnder), floorMat);
  ceiling.name = 'hold-ceiling-planking';
  ceiling.receiveShadow = true;
  g.add(ceiling);

  // Bow/stern bulkheads: the full section at the hold ends, sole to deck,
  // out to the inner planking. On a brig or galleon the AFT one is the
  // stern-cabin bulkhead: planked face, door with frame and iron strap hinges.
  const bulkheadD = 0.14;
  for (const sz of [-1, 1] as const) {
    const bzFace = sz * holdZ;
    const shape = new THREE.Shape();
    const steps = 8;
    const floorHalf = holdHalf(bzFace);
    shape.moveTo(-floorHalf, HOLD_FLOOR_Y - 0.12);
    shape.lineTo(floorHalf, HOLD_FLOOR_Y - 0.12);
    shape.lineTo(floorHalf, lockerTop + 0.05);
    for (let k = 0; k <= steps; k++) {
      const y = lockerTop + 0.05 + (k / steps) * (deckUnder - lockerTop - 0.05);
      shape.lineTo(Math.max(floorHalf, ceilAt(bzFace, y)), y);
    }
    for (let k = steps; k >= 0; k--) {
      const y = lockerTop + 0.05 + (k / steps) * (deckUnder - lockerTop - 0.05);
      shape.lineTo(-Math.max(floorHalf, ceilAt(bzFace, y)), y);
    }
    shape.lineTo(-floorHalf, lockerTop + 0.05);
    shape.closePath();
    const bgeo = new THREE.ExtrudeGeometry(shape, { depth: bulkheadD, bevelEnabled: false, curveSegments: 1 });
    const bulkhead = new THREE.Mesh(bgeo, wallMat);
    bulkhead.position.z = sz < 0 ? bzFace - bulkheadD : bzFace;
    bulkhead.name = sz < 0 ? 'hold-bulkhead-aft' : 'hold-bulkhead-fwd';
    g.add(bulkhead);
    if (sz < 0 && L >= 15) {
      // Stern-cabin bulkhead dressing on the hold face (z = -holdZ, facing +z).
      const doorW = 0.78, doorH = Math.min(1.85, deckUnder - HOLD_FLOOR_Y - 0.25);
      const doorX = Math.min(floorHalf * 0.45, floorHalf - doorW);
      const fz = bzFace;
      const battens = Math.floor((floorHalf * 2) / 0.32);
      for (let b = 0; b <= battens; b++) {
        const bx = -floorHalf + b * ((floorHalf * 2) / battens);
        if (Math.abs(bx - doorX) < doorW * 0.5 + 0.1) continue;
        const batten = new THREE.Mesh(new THREE.BoxGeometry(0.035, deckUnder - HOLD_FLOOR_Y, 0.02), darkMat);
        batten.position.set(bx, (deckUnder + HOLD_FLOOR_Y) * 0.5, fz + 0.01);
        g.add(batten);
      }
      for (const [w, h, x, y] of [
        [0.1, doorH + 0.1, doorX - doorW * 0.5 - 0.05, HOLD_FLOOR_Y + (doorH + 0.1) * 0.5],
        [0.1, doorH + 0.1, doorX + doorW * 0.5 + 0.05, HOLD_FLOOR_Y + (doorH + 0.1) * 0.5],
        [doorW + 0.2, 0.1, doorX, HOLD_FLOOR_Y + doorH + 0.05],
      ] as const) {
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), darkMat);
        jamb.position.set(x, y, fz + 0.03);
        g.add(jamb);
      }
      const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, doorH, 0.045), wallMat);
      door.position.set(doorX, HOLD_FLOOR_Y + doorH * 0.5, fz + 0.035);
      door.name = 'hold-stern-cabin-door';
      g.add(door);
      for (const hy of [0.3, doorH - 0.3]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(doorW * 0.62, 0.05, 0.012), ironMatShared);
        strap.position.set(doorX - doorW * 0.19, HOLD_FLOOR_Y + hy, fz + 0.063);
        g.add(strap);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.009, 4, 8), ironMatShared);
      ring.position.set(doorX + doorW * 0.33, HOLD_FLOOR_Y + doorH * 0.52, fz + 0.07);
      g.add(ring);
    }
  }

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const cornerPost = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, wallH, 0.16),
        darkMat,
      );
      cornerPost.name = 'hold-locker-post';
      cornerPost.position.set(sx * (holdHalf(sz * holdZ) - 0.09), wallH * 0.5 + HOLD_FLOOR_Y, sz * holdZ);
      cornerPost.castShadow = true;
      g.add(cornerPost);
    }
  }

  // Low angled bilge planks close the bottom corners that were visible from the hold.
  // Their own material (same look as darkMat) so the breach cut stays in the hold.
  // Untextured, the floor's and inner wall's material family: with the breach
  // cut all three carry the same capsule discard, so they link ONE program. A
  // darkMat clone (wood map) linked a second capsule program per match (+1 on
  // the phone's 70-program ceiling, b2 gate). The tone matches the dark timber.
  let bilgeMat: THREE.Material = darkMat;
  if (breachDiscard) {
    bilgeMat = new THREE.MeshStandardMaterial({ color: 0x2e1c0e, roughness: 0.95 });
    bilgeMat.name = 'hold-bilge-board';
    breachDiscard(bilgeMat);
  }
  for (const sx of [-1, 1] as const) {
    const bilge = new THREE.Mesh(
      new THREE.BoxGeometry(BILGE_BOARD_THICK, H * BILGE_BOARD_H_F, holdZ * 2 * BILGE_BOARD_LEN_F),
      bilgeMat,
    );
    bilge.position.set(sx * (holdHalf(0) - BILGE_BOARD_INSET), BILGE_BOARD_Y, 0);
    bilge.rotation.z = -sx * BILGE_BOARD_TILT;
    g.add(bilge);
  }

  // Deck underside — 4 box slabs surrounding the stairwell so the hole is real
  // geometry (no fragile ShapeGeometry hole-punching). Looking up from the hold
  // through the stairwell now reveals the open sky / weather deck above.
  const ceilingY = H - 0.12;
  const cw = W * 0.44;
  const cln = L * 0.46;
  const cThickness = 0.08;
  const addCeilingSlab = (cx: number, cz: number, bw: number, bd: number) => {
    if (bw <= 0.05 || bd <= 0.05) return;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(bw, cThickness, bd),
      darkMat,
    );
    slab.position.set(cx, ceilingY, cz);
    slab.receiveShadow = true;
    g.add(slab);
  };
  const cHoleZMin = hole.cz - hole.halfZ;
  const cHoleZMax = hole.cz + hole.halfZ;
  const cHoleXMin = hole.cx - hole.halfX;
  const cHoleXMax = hole.cx + hole.halfX;
  // Stern slab (south of hole, full width)
  const cSternDepth = Math.max(0, cHoleZMin - (-cln));
  if (cSternDepth > 0) addCeilingSlab(0, -cln + cSternDepth * 0.5, cw * 2, cSternDepth);
  // Bow slab (north of hole, full width)
  const cBowDepth = Math.max(0, cln - cHoleZMax);
  if (cBowDepth > 0) addCeilingSlab(0, cHoleZMax + cBowDepth * 0.5, cw * 2, cBowDepth);
  // Port mid slab (west of hole, between hole's z bounds)
  const cMidDepth = Math.max(0, cHoleZMax - cHoleZMin);
  const cPortWidth = Math.max(0, cHoleXMin - (-cw));
  if (cPortWidth > 0 && cMidDepth > 0) addCeilingSlab(-cw + cPortWidth * 0.5, hole.cz, cPortWidth, cMidDepth);
  const cStarWidth = Math.max(0, cw - cHoleXMax);
  if (cStarWidth > 0 && cMidDepth > 0) addCeilingSlab(cHoleXMax + cStarWidth * 0.5, hole.cz, cStarWidth, cMidDepth);

  // Deck-underside margin: the ceiling slabs stop at 0.44 W, the inner
  // planking reaches the hull; this down-facing strip closes the gap.
  {
    const pos: number[] = [], idx: number[] = [];
    const nz = Math.max(8, Math.ceil((holdZ * 2) / 0.5));
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < nz; i++) {
        const z0 = -holdZ + (i / nz) * holdZ * 2, z1 = -holdZ + ((i + 1) / nz) * holdZ * 2;
        const o0 = ceilAt(z0, deckUnder), o1 = ceilAt(z1, deckUnder);
        const i0 = Math.min(cw - 0.05, o0), i1 = Math.min(cw - 0.05, o1);
        addQuad(pos, idx, [side * i0, deckUnder, z0], [side * o0, deckUnder, z0], [side * o1, deckUnder, z1], [side * i1, deckUnder, z1], side < 0);
      }
    }
    g.add(new THREE.Mesh(finishGeometry(pos, idx), darkMat));
  }

  // FRAMES every 0.6 m on the inner planking, one merged draw that shares the
  // bilge boards' material (and so the breach cut).
  g.add(new THREE.Mesh(makeFrameGeometry(profile, holdZ, lockerTop + 0.05, deckUnder), bilgeMat));

  // DECK BEAMS on every third frame, ceiling to ceiling, each end on a
  // HANGING KNEE against the planking; STANCHIONS on the locker lids under
  // alternate beams (outboard of the walk clamp, so nobody walks through one).
  const beamY = deckUnder - 0.07;
  const nFrames = Math.floor((holdZ * 2 - 0.3) / HOLD_FRAME_SPACING);
  const frame0 = -((nFrames - 1) * HOLD_FRAME_SPACING) / 2;
  const kneeShape = new THREE.Shape();
  kneeShape.moveTo(0, 0); kneeShape.lineTo(-0.46, 0); kneeShape.lineTo(-0.1, -0.1); kneeShape.lineTo(0, -0.46); kneeShape.closePath();
  const kneeGeo = new THREE.ExtrudeGeometry(kneeShape, { depth: 0.09, bevelEnabled: false, curveSegments: 1 });
  let beamIdx = 0;
  for (let f = 1; f < nFrames - 1; f += 3) {
    const bz = frame0 + f * HOLD_FRAME_SPACING;
    if (bz > hole.cz - hole.halfZ - 0.18 && bz < hole.cz + hole.halfZ + 0.18) continue;
    const bw = ceilAt(bz, beamY);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(bw * 2, 0.14, 0.18), darkMat);
    beam.position.set(0, beamY, bz);
    g.add(beam);
    for (const side of [-1, 1] as const) {
      const knee = new THREE.Mesh(kneeGeo, darkMat);
      knee.position.set(side * ceilAt(bz, beamY - 0.2), beamY - 0.07, bz - 0.045);
      knee.scale.x = side;
      g.add(knee);
      if (beamIdx % 2 === 0) {
        const sx = holdHalf(bz) + 0.32;
        const reach = ceilAt(bz, lockerTop + 0.05);
        if (sx < reach - 0.1) {
          const stH = beamY - 0.07 - (lockerTop + 0.05);
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, stH, quality === 'low' ? 6 : 8), darkMat);
          post.position.set(side * sx, lockerTop + 0.05 + stH * 0.5, bz);
          g.add(post);
        }
      }
    }
    beamIdx++;
  }

  // HAMMOCKS slung fore-and-aft between frames over the lockers, and CARGO
  // NETS over stores on the lids opposite them.
  const hammockMat = new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 0.9, side: THREE.DoubleSide });
  hammockMat.name = 'hold-hammock';
  const hammockCount = Math.max(2, Math.round(L / 8));
  const sackMat = hammockMat; // canvas sacks, same cloth: no extra draw
  for (let h = 0; h < hammockCount; h++) {
    const hz = holdZ * 0.72 - h * ((holdZ * 1.44) / Math.max(hammockCount - 1, 1));
    const sx = h % 2 === 0 ? 1 : -1;
    const inner = holdHalf(hz), outer = ceilAt(hz, lockerTop + 0.05);
    const shelf = outer - inner;
    if (shelf < 0.45) continue;
    const hy = lockerTop + 0.05 + Math.min(0.95, (deckUnder - lockerTop) * 0.62);
    const hx = inner + shelf * 0.5;
    const hammock = new THREE.Mesh(makeHammockGeometry(1.7, Math.min(0.62, shelf * 0.8), 0.28), hammockMat);
    hammock.position.set(sx * Math.min(hx, ceilAt(hz, hy) - 0.36), hy, hz);
    g.add(hammock);
    for (const e of [-1, 1]) {
      const lanyard = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.34, 3, 1, true), hammockMat);
      lanyard.position.set(hammock.position.x, hy + 0.1, hz + e * 0.96);
      lanyard.rotation.x = e * 0.9;
      g.add(lanyard);
    }
    // Stores + net on the opposite lid.
    const nx = -sx * (inner + Math.min(shelf * 0.5, 0.55));
    const ny = lockerTop + 0.05;
    const rx = Math.min(0.42, shelf * 0.42), rz = 0.55;
    for (const [dx, dz, r, hh] of [[0, -0.22, 0.2, 0.42], [0.04, 0.2, 0.22, 0.36]] as const) {
      const sack = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, hh, quality === 'low' ? 6 : 8), sackMat);
      sack.position.set(nx + dx * -sx, ny + hh * 0.5, hz + dz);
      g.add(sack);
    }
    const net = new THREE.Mesh(makeCargoNetGeometry(rx, rz, 0.48), hammockMat);
    net.position.set(nx, ny, hz);
    g.add(net);
  }

  // Crates along port/starboard bilge — keep the stairwell / centerline clear so nothing blocks the view down.
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a3818, roughness: 1, map: woodMat instanceof THREE.MeshStandardMaterial ? woodMat.map : null });
  crateMat.name = 'hold-crate';
  const crateCount = Math.max(2, Math.round(L / 12));
  for (let c = 0; c < crateCount; c++) {
    const cz = -L * 0.2 - c * (L * 0.1);
    for (const sx of [-1, 1] as const) {
      const cGrp = new THREE.Group();
      cGrp.position.set(sx * Math.min(W * 0.28, holdHalf(cz) - 0.45), HOLD_FLOOR_Y, cz);

      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.72), crateMat);
      crate.position.y = 0.31;
      crate.castShadow = true;
      cGrp.add(crate);

      const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a1206, roughness: 0.6 });
      for (const sy of [0.12, 0.48]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.045, 0.055), strapMat);
        strap.position.set(0, sy, 0.37);
        cGrp.add(strap);
      }

      g.add(cGrp);
    }
  }

  // TWO LANTERNS, ONE BUDGET LIGHT (ships-23).
  //
  // The hold had a single 18 cm CUBE hanging amidships, and that cube was the
  // only thing in the ship's belly that was supposed to read as a light. A box
  // does not read as a lantern from a metre away, and one of them amidships
  // left both ends of a galleon's hold — which is nearly nine metres of it —
  // with no visible source at all for the pool of light on the floor.
  //
  // So: two lanterns, hung fore and aft off the deck beams, each with a
  // silhouette (tapered glass, iron cap, hook) instead of a cube. They sit
  // SYMMETRICALLY about the point light, which does not move, does not change
  // intensity or range, and is still registered exactly once — the light budget
  // sees no difference whatsoever (test-light-budget). Both lanterns are
  // emissive, so both read as burning and the pool between them is attributed
  // to the pair; only one of them is a real emitter, and at hold scale nobody
  // can tell which. That is the whole trick, and it is the reason a second
  // lantern costs zero lights.
  //
  // WHAT IT COSTS ON THE LOW TIER: four radial sides instead of six, so a
  // lantern is 28 triangles and the pair is 56 per hull (84 elsewhere). All six
  // meshes share two materials, so they merge into the hull's existing static
  // bake and add no draw call at all. The hold is interior geometry behind the
  // detail root, so a distant hull never builds or draws them.
  const lanternSides = quality === 'low' ? 4 : 6;
  // Horn glass + flame card in ONE additive vertex-coloured material: the
  // glass is a dim amber shell you see into, the crossed flame card inside is
  // what burns (b2.3e). One draw for both lanterns, as before.
  const glassMat = new THREE.MeshBasicMaterial({
    map: lanternTintTexture(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  glassMat.name = 'hold-lantern-glass';
  const ironMat = ironMatShared;
  const lanternY = H * 0.55;
  const lanternZ = Math.min(L * 0.16, holdZ * 0.62);
  for (const lz of [-lanternZ, lanternZ]) {
    // Tapered glass: wider at the shoulder than at the foot, the way a horn
    // lantern is, so it catches the light differently top and bottom.
    const glassGeo = new THREE.CylinderGeometry(0.105, 0.078, 0.22, lanternSides);
    tintGeometry(glassGeo, LANTERN_TEXEL.glass);
    const glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.set(0, lanternY, lz);
    g.add(glass);
    for (const ry of [0, Math.PI * 0.5]) {
      const flameGeo = new THREE.PlaneGeometry(0.055, 0.12, 1, 2);
      const fp = flameGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < fp.count; i++) if (fp.getY(i) > 0.05) fp.setX(i, 0);
      tintGeometry(flameGeo, LANTERN_TEXEL.flame);
      const flame = new THREE.Mesh(flameGeo, glassMat);
      flame.position.set(0, lanternY - 0.01, lz);
      flame.rotation.y = ry;
      g.add(flame);
    }
    // Open-ended: the cap's top is against the beam and its underside is
    // against the glass, so both discs are geometry nobody can ever see. Same
    // for the hook, which is buried at both ends. That is 36 triangles a pair
    // saved for nothing given up.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.115, 0.115, 0.045, lanternSides, 1, true), ironMat,
    );
    cap.position.set(0, lanternY + 0.13, lz);
    g.add(cap);
    // The hook it hangs by: without it the lantern floats under the beams.
    const hook = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.011, 0.14, 3, 1, true), ironMat,
    );
    hook.position.set(0, lanternY + 0.22, lz);
    g.add(hook);
  }

  // THE HOLD IS WINDOWLESS, so what the sun is doing outside is irrelevant to
  // it: this lantern burns on the middle watch and it burns at noon. It was
  // built with `visible = false` and nothing in the ship update ever turned it
  // on, so the one light source below deck never lit anything and the hold read
  // as a black box at every hour — you walked down the companionway into ink.
  //
  // Its REACH is deliberately hold-sized rather than ship-sized. The light
  // budget ranks emitters by intensity x (1 - dist/range)^2, so a 22 m lantern
  // on every hull in the anchorage would sit in the pool competing with the
  // torches and braziers you can actually see; at 8.5 m it can only win a slot
  // for someone who is standing in the hold it belongs to, which is exactly who
  // it is for.
  const holdLight = new THREE.PointLight(0xFFB060, 1.15, 8.5, 1.25);
  holdLight.position.set(0, H * 0.55, 0);
  holdLight.name = 'hold-lantern';
  registerBudgetLight(holdLight);
  holdLight.visible = true;
  g.add(holdLight);

  // Brighten the hold floor so it doesn't look like a flat brown tarp from above.
  // Replace the original drab floorMat by tweaking the existing floor mesh's material.
  // (Done by creating a new lighter material; original mesh kept in scope above.)

  return g;
}

/**
 * THE HOLD CARGO STACK — the 9000-gold race, made a thing you can walk down to
 * and look at.
 *
 * The win condition of this battle royale used to have no body: gold was a
 * number in the corner of the HUD and the hold of the ship carrying it was as
 * empty as everyone else's. This builds the crates, coin-spill and strongboxes
 * that fill that hold as the crew's cargo grows (shared/cargo.ts tiers), so
 * "who is winning" is a question you answer by looking at a ship's belly.
 *
 * Built as FOUR cumulative merged variants (tier 1 lots … tiers 1-4 lots), of
 * which exactly one is ever visible: a laden hull costs two extra draw calls,
 * an empty one costs none. Growing the stack by toggling meshes rather than
 * spawning crates keeps this off the per-frame allocation path entirely.
 */
export function makeHoldCargoStacks(
  stats: { width: number; length: number; height: number },
  crateMat: THREE.Material,
  goldMat: THREE.Material,
  /** Hull class. Given, the four cumulative tiers are shared across every hull
   *  of the class instead of merged and kept per ship (perf-15). */
  cacheKey?: string,
): { group: THREE.Group; tiers: THREE.Object3D[] } {
  const W = stats.width, L = stats.length, H = stats.height;
  const floorY = 0.41;                    // top of the hold's floor slab
  const headroom = Math.max(0.7, H - 0.45);
  const group = new THREE.Group();
  group.name = 'hold-cargo';

  /** One stowed lot: crates + a coin pile, at a spot clear of the stairwell. */
  const lots: Array<() => { crates: THREE.BufferGeometry[]; gold: THREE.BufferGeometry[] }> = [];
  const stow = (lx: number, lz: number, crateCount: number, coins: number, seed: number) => {
    lots.push(() => {
      const crates: THREE.BufferGeometry[] = [];
      const gold: THREE.BufferGeometry[] = [];
      for (let i = 0; i < crateCount; i += 1) {
        const s = 0.42 + ((seed + i * 7) % 5) * 0.045;
        const h = Math.min(s, headroom * 0.42);
        const level = Math.floor(i / 2);
        const geo = new THREE.BoxGeometry(s, h, s * 0.86);
        geo.rotateY(((seed + i * 13) % 9 - 4) * 0.06);
        geo.translate(
          lx + ((i % 2) * 2 - 1) * s * 0.56,
          Math.min(floorY + h * 0.5 + level * h * 1.02, floorY + headroom - h * 0.5),
          lz + (((seed + i) % 3) - 1) * 0.12,
        );
        crates.push(geo);
      }
      // Coin spill: flat gold discs at the crates' feet. Cheap, and the only
      // warm-metal thing below decks — it reads as money from the stairwell.
      for (let i = 0; i < coins; i += 1) {
        const r = 0.13 + ((seed + i * 3) % 4) * 0.02;
        const geo = new THREE.CylinderGeometry(r, r * 1.12, 0.055 + (i % 3) * 0.02, 8);
        const a = (i / Math.max(1, coins)) * Math.PI * 2 + seed;
        geo.translate(
          lx + Math.cos(a) * (0.32 + (i % 2) * 0.18),
          floorY + 0.03 + (i % 2) * 0.03,
          lz + Math.sin(a) * (0.3 + (i % 3) * 0.14),
        );
        gold.push(geo);
      }
      return { crates, gold };
    });
  };

  // Stowage plan: aft of the stairwell first (a crew stows heavy aft), then the
  // forward hold, then the wings. The companionway (getShipCompanionwayConfig,
  // roughly z ∈ [-L*0.05, L*0.21] near the centreline) stays walkable at every
  // tier — cargo may never wall a pirate off from their own ladder.
  stow(-W * 0.16, -L * 0.24, 3, 5, 1);
  stow(W * 0.19, -L * 0.31, 4, 6, 4);
  stow(-W * 0.20, L * 0.30, 4, 7, 7);
  stow(W * 0.17, L * 0.33, 5, 9, 2);

  const tiers: THREE.Object3D[] = [];
  const crateGeos: THREE.BufferGeometry[] = [];
  const goldGeos: THREE.BufferGeometry[] = [];
  for (const buildLot of lots) {
    const lot = buildLot();
    crateGeos.push(...lot.crates);
    goldGeos.push(...lot.gold);
    const tier = new THREE.Group();
    const tierIndex = tiers.length;
    const share = <T extends THREE.BufferGeometry | null>(part: string, build: () => T): T =>
      (cacheKey ? acquireSharedGeometry(`cargo-${cacheKey}-${part}${tierIndex}`, build) : build()) as T;
    const crates = share('crates', () => mergeGeometries(crateGeos.map((g) => g.clone()), false));
    const coins = share('coins', () => mergeGeometries(goldGeos.map((g) => g.clone()), false));
    if (crates) {
      const mesh = new THREE.Mesh(crates, crateMat);
      mesh.castShadow = true;
      tier.add(mesh);
    }
    if (coins) tier.add(new THREE.Mesh(coins, goldMat));
    tier.visible = false;
    group.add(tier);
    tiers.push(tier);
  }
  for (const geo of crateGeos) geo.dispose();
  for (const geo of goldGeos) geo.dispose();

  return { group, tiers };
}

