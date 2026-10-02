// THE STATIC WORLD AS A PURE FUNCTION OF (seed, WORLD_VERSION)  — D30, performance-05
//
// Today the server serialises every island, prop, cave, dock, sea rock and
// collider into the join payload (65 KB compressed, ~237 KB raw, ~13 KB from
// its ceiling), and the islands rebuild would blow it on the first new
// landform. The fix is to ship two numbers instead of the world: both ends run
// THIS generator and must land on the same bytes, which `worldHash` proves
// (b4.1b sends seed + WORLD_VERSION + deltas and falls back to a full
// `world_sync` on a hash mismatch; b4.1c runs this in a worker on the client).
//
// Byte-identical across JS ENGINES, not just across processes. V8 and
// JavaScriptCore (every iPhone/iPad, Safari on the Mac) do not share a libm:
// Math.sin / cos / atan2 / hypot / exp / pow are "implementation-approximated"
// in ECMA-262 and differ in the last ulp for some inputs. A one-ulp difference
// in a spacing test (`d < spacing`) is a prop that exists on the server and not
// on the phone. Placement therefore runs under `withDeterministicMath`, which
// swaps those functions for the fdlibm-derived kernels below for the duration
// of the synchronous generation call. The kernels use only + - * / and
// Math.sqrt / floor / round / abs, all of which ECMA-262 pins to IEEE-754
// round-to-nearest per operation (and forbids fused multiply-add), so every
// conforming engine produces the same bits. Integer RNG (mulberry32 via
// Math.imul) is exact everywhere already.
//
// Consumers: server — Match.setupWorld (wired in b4.1b); client — the static
// world worker (b4.1c). Gate: scripts/test-static-world-determinism.mjs.

import { MapGenerator } from '../server/world/MapGenerator.js';
import type { Island, SeaPoi, SeaRock, WildlifeAnimal } from './types/index.js';
import { PROP_COLLIDERS } from './props.js';
import { getIslandMaxRadius, getIslandSurfaceY } from './utils/index.js';

/** Bump when ANY generator input changes the static world (roster, landform,
 *  placement rule, collider table). A client on another version must not
 *  regenerate: b4.1b falls back to a full world_sync. */
export const WORLD_VERSION = 9;

// ── Deterministic transcendental kernels (fdlibm 5.3 constants) ──────────────

const INVPIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;

function kSin(x: number, y: number): number {
  const z = x * x;
  const v = z * x;
  const r = 8.33333333332248946124e-03 + z * (-1.98412698298579493134e-04 + z * (2.75573137070700676789e-06
    + z * (-2.50507602534068634195e-08 + z * 1.58969099521155010221e-10)));
  return x - ((z * (0.5 * y - v * r) - y) - v * -1.66666666666666324348e-01);
}

function kCos(x: number, y: number): number {
  const z = x * x;
  const r = z * (4.16666666666666019037e-02 + z * (-1.38888888888741095749e-03 + z * (2.48015872894767294178e-05
    + z * (-2.75573143513906633035e-07 + z * (2.08757232129817482790e-09 + z * -1.13596475577881948265e-11)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (((1 - w) - hz) + (z * r - x * y));
}

/** Cody-Waite reduction to [-pi/4, pi/4] with a 118-bit pi/2 (fdlibm's medium
 *  path, always taking the second iteration). Exact for |x| < 2^19 * pi/2;
 *  beyond that it is still deterministic, just less accurate. */
function reduce(x: number): [number, number, number] {
  const fn = Math.round(x * INVPIO2);
  // fdlibm's second iteration (the pio2_1t tail is superseded by pio2_2/2t)
  const t = x - fn * PIO2_1;
  let w = fn * PIO2_2;
  const r = t - w;
  w = fn * PIO2_2T - ((t - r) - w);
  const y0 = r - w;
  const y1 = (r - y0) - w;
  const q = ((fn % 4) + 4) % 4;
  return [q, y0, y1];
}

function dsin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return Math.abs(x) < 7.450580596923828e-9 ? x : kSin(x, 0);
  const [q, a, b] = reduce(x);
  return q === 0 ? kSin(a, b) : q === 1 ? kCos(a, b) : q === 2 ? -kSin(a, b) : -kCos(a, b);
}

function dcos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  if (Math.abs(x) <= 0.7853981633974483) return Math.abs(x) < 7.450580596923828e-9 ? 1 : kCos(x, 0);
  const [q, a, b] = reduce(x);
  return q === 0 ? kCos(a, b) : q === 1 ? -kSin(a, b) : q === 2 ? -kCos(a, b) : kSin(a, b);
}

const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02,
];

function datan(v: number): number {
  if (Number.isNaN(v)) return NaN;
  const neg = v < 0 || Object.is(v, -0);
  let x = Math.abs(v);
  if (x >= 7.378697629483821e19) return neg ? -(ATANHI[3] + ATANLO[3]) : ATANHI[3] + ATANLO[3];
  let id = -1;
  if (x < 0.4375) {
    if (x < 3.725290298461914e-9) return v;
  } else if (x < 1.1875) {
    if (x < 0.6875) { id = 0; x = (2 * x - 1) / (2 + x); } else { id = 1; x = (x - 1) / (x + 1); }
  } else if (x < 2.4375) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); } else { id = 3; x = -1 / x; }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return neg ? -(x - x * (s1 + s2)) : x - x * (s1 + s2);
  const r = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
  return neg ? -r : r;
}

const PI = 3.1415926535897931160e+00;
const PI_LO = 1.2246467991473531772e-16;

function datan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  const yNeg = y < 0 || Object.is(y, -0);
  const xNeg = x < 0 || Object.is(x, -0);
  if (y === 0) return xNeg ? (yNeg ? -PI : PI) : y;
  if (x === 0) return yNeg ? -PI / 2 : PI / 2;
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) return (yNeg ? -1 : 1) * (xNeg ? 3 * PI / 4 : PI / 4);
    return xNeg ? (yNeg ? -PI : PI) : (yNeg ? -0 : 0);
  }
  if (!Number.isFinite(y)) return yNeg ? -PI / 2 : PI / 2;
  const ratio = Math.abs(y / x);
  let z: number;
  if (ratio > 1.152921504606847e18) z = PI / 2 + 0.5 * PI_LO;
  else if (xNeg && ratio < 8.673617379884035e-19) z = 0;
  else z = datan(ratio);
  if (!xNeg) return yNeg ? -z : z;
  return yNeg ? (z - PI_LO) - PI : PI - (z - PI_LO);
}

/** Exact 2^k for integer k in [-1074, 1023], built from the bit pattern (never
 *  Math.pow, which ECMA-262 does not pin). */
const POW2_VIEW = new DataView(new ArrayBuffer(8));
function pow2(k: number): number {
  if (k > 1023) return Infinity;
  if (k < -1022) return pow2(k + 1000) * pow2(-1000); // two exact scalings, subnormal-safe
  POW2_VIEW.setUint32(0, (k + 1023) << 20);
  POW2_VIEW.setUint32(4, 0);
  return POW2_VIEW.getFloat64(0);
}

const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;

function dexp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.782712893383973096) return Infinity;
  if (x < -745.13321910194110842) return 0;
  if (Math.abs(x) < 3.725290298461914e-9) return 1 + x;
  const k = Math.round(x * 1.44269504088896338700e+00);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (1.66666666666666019037e-01 + t * (-2.77777777770155933842e-03 + t * (6.61375632143793436117e-05
    + t * (-1.65339022054652515390e-06 + t * 4.13813679705723846039e-08))));
  const y = 1 - ((lo - (r * c) / (2 - c)) - hi);
  if (k < -1021) return y * pow2(k + 1000) * pow2(-1000);
  return k === 1024 ? y * 2 * pow2(1023) : y * pow2(k);
}

function dlog(v: number): number {
  if (Number.isNaN(v) || v < 0) return NaN;
  if (v === 0) return -Infinity;
  if (!Number.isFinite(v)) return Infinity;
  // frexp from the bit pattern: v = m * 2^k, m in [sqrt(2)/2, sqrt(2))
  let x = v;
  let k = 0;
  if (x < 2.2250738585072014e-308) { x *= 18014398509481984; k -= 54; } // subnormal: scale by 2^54
  POW2_VIEW.setFloat64(0, x);
  const hiWord = POW2_VIEW.getUint32(0);
  k += ((hiWord >>> 20) & 0x7ff) - 1023;
  POW2_VIEW.setUint32(0, (hiWord & 0x000fffff) | 0x3ff00000);
  let m = POW2_VIEW.getFloat64(0);
  if (m >= 1.4142135623730951) { m *= 0.5; k += 1; }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (3.999999999940941908e-01 + w * (2.222219843214978396e-01 + w * 1.531383769920937332e-01));
  const t2 = z * (6.666666666666735130e-01 + w * (2.857142874366239149e-01 + w * (1.818357216161805012e-01 + w * 1.479819860511658591e-01)));
  const R = t2 + t1;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
}

function ipow(x: number, n: number): number {
  let result = 1;
  let base = x;
  let e = Math.abs(n);
  while (e > 0) {
    if (e & 1) result *= base;
    base *= base;
    e = Math.floor(e / 2);
  }
  return n < 0 ? 1 / result : result;
}

function dpow(x: number, y: number): number {
  if (y === 0) return 1;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (y === 1) return x;
  if (y === 0.5 && x >= 0) return Math.sqrt(x);
  if (Number.isInteger(y) && Math.abs(y) <= 64) return ipow(x, y);
  if (Number.isInteger(2 * y) && Math.abs(y) <= 64 && x >= 0) return ipow(x, Math.floor(y)) * Math.sqrt(x);
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return Number.isInteger(y) ? (Math.abs(y) % 2 === 1 ? -1 : 1) * dexp(y * dlog(-x)) : NaN;
  return dexp(y * dlog(x));
}

function dhypot(...values: number[]): number {
  let sum = 0;
  for (const v of values) {
    if (v === Infinity || v === -Infinity) return Infinity;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

/** Engine-independent replacements for the libm functions ECMA-262 leaves
 *  implementation-approximated. Exported so new placement code can call them
 *  directly instead of relying on the swap below. */
export const detMath = {
  sin: dsin, cos: dcos, tan: (x: number) => dsin(x) / dcos(x), atan: datan, atan2: datan2,
  exp: dexp, log: dlog, pow: dpow, hypot: dhypot,
} as const;

type SwappedKey = keyof typeof detMath;
const SWAPPED = Object.keys(detMath) as SwappedKey[];
let swapDepth = 0;
let saved: Partial<Record<SwappedKey, unknown>> = {};

/** Run `fn` SYNCHRONOUSLY with Math.sin/cos/tan/atan/atan2/exp/log/pow/hypot
 *  replaced by `detMath`, restoring the engine's functions afterwards (also on
 *  throw). This is how placement code that predates D30 (MapGenerator, the
 *  terrain truth in shared/utils) becomes engine-independent without every call
 *  site changing. Never pass an async function: other code on the thread must
 *  not observe the swap across an await. */
export function withDeterministicMath<T>(fn: () => T): T {
  const m = Math as unknown as Record<SwappedKey, unknown>;
  if (swapDepth === 0) {
    saved = {};
    for (const key of SWAPPED) { saved[key] = m[key]; m[key] = detMath[key]; }
  }
  swapDepth += 1;
  try {
    const out = fn();
    if (out && typeof (out as { then?: unknown }).then === 'function') {
      throw new Error('withDeterministicMath: fn must be synchronous');
    }
    return out;
  } finally {
    swapDepth -= 1;
    if (swapDepth === 0) for (const key of SWAPPED) m[key] = saved[key];
  }
}

// ── The generator ────────────────────────────────────────────────────────────

export type StaticShipSpawn = ReturnType<MapGenerator['generateShipSpawns']>[number];

export interface StaticWorld {
  version: number;
  seed: number;
  islands: Island[];
  /** Berths the hulls start at (placement truth, static per world). */
  spawns: StaticShipSpawn[];
  seaPois: SeaPoi[];
  seaRocks: SeaRock[];
  /** Initial herd. Drawn in sequence (so it must be generated here to keep the
   *  draw order Match.setupWorld uses) but it MOVES, so it is not in worldHash. */
  wildlife: WildlifeAnimal[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace every per-match uuid (chests, barrels, npcs, sea rocks, wildlife)
 *  with a stable path id, and rewrite every string that referenced the old id,
 *  so both ends name the same object the same way (deltas address statics by
 *  these ids). Walk order is the object's own key order, which the generator
 *  fixes. */
function canonicalizeIds(root: Record<string, unknown>): void {
  const remap = new Map<string, string>();
  const assign = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((child, i) => assign(child, `${path}.${i}`)); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const id = obj.id;
    if (typeof id === 'string' && UUID_RE.test(id) && !remap.has(id)) remap.set(id, path);
    const childBase = typeof id === 'string' && !UUID_RE.test(id) ? id : path;
    for (const key of Object.keys(obj)) assign(obj[key], `${childBase}.${key}`);
  };
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string' && remap.has(v)) node[i] = remap.get(v);
        else rewrite(v);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string' && remap.has(v)) obj[key] = remap.get(v);
      else rewrite(v);
    }
  };
  for (const key of Object.keys(root)) assign(root[key], key);
  rewrite(root);
}

/** THE static world. Same (seed, version) ⇒ the same bytes on every engine.
 *  Mirrors Match.setupWorld's draw order exactly (islands, spawns, wildlife,
 *  sea POIs + their loot, sea rocks). */
export function generateStaticWorld(seed: number, version: number = WORLD_VERSION): StaticWorld {
  return generateStaticWorldWith(new MapGenerator(seed >>> 0), version);
}

/** generateStaticWorld on a caller-owned generator (b4.1b): Match keeps drawing
 *  bot names, hulls and wreck loot from the SAME MapGenerator stream after the
 *  world, so it must run the world draws on that instance, not a fresh one.
 *  `gen` must be fresh (no draws taken yet). */
export function generateStaticWorldWith(gen: MapGenerator, version: number = WORLD_VERSION): StaticWorld {
  if (version !== WORLD_VERSION) {
    throw new Error(`generateStaticWorld: world version ${version} is not this build's ${WORLD_VERSION}`);
  }
  // eslint-disable-next-line dot-notation -- the seed is the generator's own, deliberately private
  const s = gen['seed'] >>> 0;
  return withDeterministicMath(() => {
    const islands = gen.generateIslands();
    const spawns = gen.generateShipSpawns(islands);
    const wildlife = gen.generateWildlife(islands);
    const seaPois = gen.generateSeaPois(islands);
    gen.attachSeaPoiLoot(seaPois, islands);
    const seaRocks = gen.generateSeaRocks(islands, spawns, seaPois);
    const world: StaticWorld = { version, seed: s, islands, spawns, seaPois, seaRocks, wildlife };
    canonicalizeIds(world as unknown as Record<string, unknown>);
    return world;
  });
}

// ── Canonical bytes + hashes ─────────────────────────────────────────────────

/** Key-sorted JSON. Number → string is pinned by ECMA-262 (shortest
 *  round-trip), so equal doubles print equal bytes on every engine. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

/** 64-bit hash as 16 hex chars: two independently seeded 32-bit
 *  multiply-xorshift lanes over UTF-16 code units (Math.imul is exact). */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** The collision truth a player actually walks and sails into, flattened to
 *  numbers: every prop's main collider and yaw-rotated sub-colliders in world
 *  space ON the terrain height under it, a terrain height grid per island, and
 *  every sea rock primitive. Hashing this (not just the prop list) is what
 *  catches a terrain kernel that drifts by an ulp and lifts a collider. */
export function staticColliderGeometry(world: StaticWorld): number[] {
  return withDeterministicMath(() => {
    const out: number[] = [];
    const types = Object.keys(PROP_COLLIDERS).sort();
    world.islands.forEach((island, islandIndex) => {
      const R = getIslandMaxRadius(island);
      const N = 16;
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          const x = island.position.x + (i / N * 2 - 1) * R;
          const z = island.position.z + (j / N * 2 - 1) * R;
          out.push(getIslandSurfaceY(island, x, z));
        }
      }
      for (const prop of island.props ?? []) {
        const col = PROP_COLLIDERS[prop.type];
        if (!col) continue;
        const baseY = getIslandSurfaceY(island, prop.x, prop.z);
        out.push(islandIndex, types.indexOf(prop.type), prop.x, prop.z, baseY);
        if (col.shape !== 'none') out.push(col.radius * prop.scale, col.height * prop.scale);
        const cos = Math.cos(prop.yaw);
        const sin = Math.sin(prop.yaw);
        for (const sub of col.subColliders ?? []) {
          out.push(
            prop.x + (sub.dx * cos + sub.dz * sin) * prop.scale,
            prop.z + (sub.dz * cos - sub.dx * sin) * prop.scale,
            sub.radius * prop.scale,
            baseY + sub.height * prop.scale,
          );
        }
      }
    });
    for (const rock of world.seaRocks) {
      out.push(rock.position.x, rock.position.z, rock.colliderBoundsRadius);
      for (const c of rock.colliders) for (const v of Object.values(c)) if (typeof v === 'number') out.push(v);
    }
    return out;
  });
}

export interface StaticWorldHashes {
  /** Every static byte the join used to carry (wildlife excluded: it moves). */
  worldHash: string;
  /** staticColliderGeometry hashed bit-exactly. */
  colliderHash: string;
  /** Per-section hashes, for pointing at WHAT diverged. */
  sections: Record<'islands' | 'spawns' | 'seaPois' | 'seaRocks', string>;
}

function hashFloats(values: number[]): string {
  const buf = new Float64Array(values);
  const words = new Uint32Array(buf.buffer);
  let text = '';
  for (let i = 0; i < words.length; i++) text += String.fromCharCode(words[i] & 0xffff, words[i] >>> 16);
  return hashString(text);
}

export function hashStaticWorld(world: StaticWorld): StaticWorldHashes {
  const sections = {
    islands: hashString(canonicalJson(world.islands)),
    spawns: hashString(canonicalJson(world.spawns)),
    seaPois: hashString(canonicalJson(world.seaPois)),
    seaRocks: hashString(canonicalJson(world.seaRocks)),
  };
  const colliderHash = hashFloats(staticColliderGeometry(world));
  const worldHash = hashString(`v${world.version}|s${world.seed}|${sections.islands}|${sections.spawns}|${sections.seaPois}|${sections.seaRocks}|${colliderHash}`);
  return { worldHash, colliderHash, sections };
}
