/**
 * BREACH GEOMETRY v2 (b2.3d, ships-06 + vm:assets:2).
 *
 * Every hole used to be the same drilled disc: a sphere-distance discard of one
 * fixed radius, a flat RingGeometry rim and seven 4-sided cones, and the repair
 * was a cartoon X of two planks. A real breach is torn ALONG the planking: the
 * strakes break at their butts, the broken ends are driven inboard by the shot,
 * the wound is longer than it is tall, and the carpenter nails new planks along
 * the same strakes.
 *
 * One outline function, two evaluators that must agree:
 *   - `breachRadiusAt` (JS) builds the torn edge mesh and the repair size;
 *   - `BREACH_GLSL` (generated from the SAME constants) is what the hull,
 *     strake, armour and hold materials discard with, per fragment, from the
 *     existing hole uniforms plus one vec4 per slot (strake tangent + seed).
 *     No texture fetch and no per-hole program: the cache key scheme
 *     `hull-hole-discard-<slots>[|capsule]` is unchanged.
 *
 * Frame convention (shared by shader and mesh): x = along the strake tangent T,
 * y = across, signed so +y points UP (the shader has no normal, it takes the
 * sign of the across vector's world y), z = outward shell normal. T's sign is
 * chosen per hole so (T, up-across, N) is right-handed; `breachBasis` does that.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hullSurfacePointAt, type HullProfile } from '../../../shared/hull.js';

/** Length / height of the wound: 1.4x longer along the strake than across it
 *  (area-preserving split of the size radius). */
export const BREACH_STRETCH = 1.4;
const SX = Math.sqrt(BREACH_STRETCH);
const SY = 1 / Math.sqrt(BREACH_STRETCH);
/** Low harmonics tear the outline into lobes; a 17-tooth saw splinters it. */
const HARMONICS: ReadonlyArray<{ k: number; a: number; p: number }> = [
  { k: 3, a: 0.16, p: 17.13 },
  { k: 5, a: 0.13, p: 31.71 },
  { k: 7, a: 0.1, p: 47.29 },
  { k: 11, a: 0.08, p: 73.93 },
];
const TEETH = 17;
const TEETH_A = 0.06;
const JAG_MIN = 0.45;
/** Upper bound of the radius factor over any seed (ellipse x jag). */
export const BREACH_REACH = SX * (1 + HARMONICS.reduce((s, h) => s + h.a, 0) + TEETH_A);
/** Depth of the torn plank wall (the shell has zero thickness at the cut). */
export const BREACH_RIM_DEPTH = 0.08;
const TAU = Math.PI * 2;

const fract = (v: number) => v - Math.floor(v);

/** Seed in [0, 1) from the hole id: the same id tears the same way on every
 *  client and every build. */
export function breachSeed(id: number): number {
  let h = (Math.imul((id | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 8) / 16777216;
}

/** The jag factor alone (1 = the stretched ellipse). */
export function breachJag(theta: number, seed: number): number {
  let j = 1;
  for (let i = 0; i < HARMONICS.length; i++) {
    const h = HARMONICS[i];
    j += h.a * Math.cos(h.k * theta + TAU * fract(seed * h.p + 0.37 * (i + 1)));
  }
  const tw = fract((TEETH * theta) / TAU + seed * 5);
  j += TEETH_A * (1 - 4 * Math.abs(tw - 0.5));
  return Math.max(j, JAG_MIN);
}

/** Outline radius at angle theta (from the strake axis) for a size radius R. */
export function breachRadiusAt(theta: number, seed: number, R: number): number {
  const c = Math.cos(theta) / SX;
  const s = Math.sin(theta) / SY;
  return (R * breachJag(theta, seed)) / Math.sqrt(c * c + s * s);
}

/** JS mirror of the shader cut: is offset `d` (hull-local, from the nearest
 *  point on the hole's axis) inside the torn outline? */
export function breachCuts(d: THREE.Vector3, tangent: THREE.Vector3, seed: number, R: number): boolean {
  if (!(R > 0)) return false;
  const len = d.length();
  if (len >= R * BREACH_REACH) return false;
  const al = d.dot(tangent);
  const ax = d.x - tangent.x * al, ay = d.y - tangent.y * al, az = d.z - tangent.z * al;
  const across = Math.hypot(ax, ay, az) * (ay < 0 ? -1 : 1);
  return len < breachRadiusAt(Math.atan2(across, al + 1e-6), seed, R);
}

/** Half extents of the wound (along the strake, across it, and the furthest
 *  point) for one seed, sampled on the outline. */
export function breachExtent(seed: number, R: number) {
  let along = 0, across = 0, max = 0;
  for (let i = 0; i < 96; i++) {
    const th = (i / 96) * TAU;
    const r = breachRadiusAt(th, seed, R);
    along = Math.max(along, Math.abs(Math.cos(th) * r));
    across = Math.max(across, Math.abs(Math.sin(th) * r));
    max = Math.max(max, r);
  }
  return { along, across, max };
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** GLSL twin of breachRadiusAt, generated from the same table. */
export const BREACH_GLSL = `
float breachR(vec3 d, vec4 shape, float R) {
  float al = dot(d, shape.xyz);
  vec3 ac = d - shape.xyz * al;
  float th = atan(length(ac) * (ac.y < 0.0 ? -1.0 : 1.0), al + 1e-6);
  float s = shape.w;
  float j = 1.0${HARMONICS.map((h, i) => ` + ${f(h.a)} * cos(${f(h.k)} * th + 6.2831853 * fract(s * ${f(h.p)} + ${f(0.37 * (i + 1))}))`).join('')};
  j += ${f(TEETH_A)} * (1.0 - 4.0 * abs(fract(${f(TEETH)} * th / 6.2831853 + s * 5.0) - 0.5));
  j = max(j, ${f(JAG_MIN)});
  float c = cos(th) / ${f(SX)};
  float sn = sin(th) / ${f(SY)};
  return R * j * inversesqrt(c * c + sn * sn);
}`;

/** The per-slot fragment test. `uHoles` (xyz point, w size radius),
 *  `uHoleShape` (xyz strake tangent, w seed) and, for capsule materials,
 *  `uHoleEnds` (the inboard seat). */
export function breachDiscardGlsl(slots: number, capsule: boolean): string {
  const axis = capsule
    ? 'vec3 hAB = uHoleEnds[i].xyz - uHoles[i].xyz; float hT = clamp(dot(vHullPos - uHoles[i].xyz, hAB) / max(dot(hAB, hAB), 1e-6), 0.0, 1.0); vec3 hD = vHullPos - (uHoles[i].xyz + hAB * hT);'
    : 'vec3 hD = vHullPos - uHoles[i].xyz;';
  return `for (int i = 0; i < ${slots}; i++) { if (uHoles[i].w > 0.0) { ${axis} float hL = length(hD); if (hL < uHoles[i].w * ${f(BREACH_REACH)} && hL < breachR(hD, uHoleShape[i], uHoles[i].w)) discard; } }`;
}

/**
 * Strake tangent at a hull-local surface point: planks run at constant hull y
 * (hullUvV depends on y alone), so the tangent is d(surface)/dz at the hole's
 * height. End-cap holes (stem/transom) run athwartships.
 */
export function strakeTangentAt(profile: HullProfile, point: THREE.Vector3, normal: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const sts = profile.stations;
  const endCap = Math.abs(normal.z) > 0.7 || point.z <= sts[0].baseZ + 0.25 || point.z >= sts[sts.length - 1].baseZ - 0.25;
  if (endCap) out.set(1, 0, 0);
  else {
    const dz = 0.2;
    const sign = point.x < 0 ? -1 : 1;
    const a = hullSurfacePointAt(profile, point.z - dz, point.y).x;
    const b = hullSurfacePointAt(profile, point.z + dz, point.y).x;
    out.set(sign * (b - a), 0, 2 * dz);
  }
  // NOT projected onto the section normal: that normal ignores the hull's
  // taper along z, and projecting onto it bent the strake 5-7 deg off the
  // planking at the flare (b2.3d gate). The frame bends the facing instead.
  return out.normalize();
}

/**
 * Right-handed breach frame for a facing and a tangent: x along the strake,
 * y across with +y up (the shader's sign rule), z = the facing squared to x. Returns whether the
 * tangent had to be reversed to keep y up.
 */
export function breachBasis(tangent: THREE.Vector3, facing: THREE.Vector3, quat: THREE.Quaternion, xOut?: THREE.Vector3): boolean {
  // x stays exactly on the strake; the facing is squared up to it (the true
  // surface normal where the hull tapers).
  const x = new THREE.Vector3().copy(tangent).normalize();
  const z = new THREE.Vector3().copy(facing).addScaledVector(x, -facing.dot(x)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  // A floor-facing seat has a horizontal y: then keep the tangent as given.
  const flipped = Math.abs(y.y) > 0.05 ? y.y < 0 : false;
  if (flipped) { x.negate(); y.negate(); }
  quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  xOut?.copy(x);
  return flipped;
}

/** Tiny deterministic stream for the mesh details. */
function stream(seed: number) {
  let s = (Math.floor(seed * 4294967296) ^ 0x2545f491) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
}

function colorize(geo: THREE.BufferGeometry, rgb: readonly [number, number, number]) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

const CHAR: readonly [number, number, number] = [0.09, 0.055, 0.03];
const TORN: readonly [number, number, number] = [0.36, 0.24, 0.13];
const FRESH: readonly [number, number, number] = [0.62, 0.45, 0.27];

export interface BreachEdgeInfo {
  /** Broken plank ends: root and tip in frame space (for the gates). */
  plankEnds: Array<{ root: THREE.Vector3; tip: THREE.Vector3; bendDeg: number }>;
  splinters: number;
}

/**
 * The torn edge of one breach as ONE geometry (vertex colours, one draw):
 * a charred lip on the face, the 0.08 m wall of broken plank closing the
 * zero-thickness shell, 5-9 broken plank ends at the strake butts bent 20-50
 * degrees away from the face (inboard for the outboard edge; for the inboard
 * ring, `inboard` bends them INTO the hold, the way the shot drove them), and
 * splinters on the far face. Built in the breach frame; `mirrorX` negates x for
 * a frame whose tangent was reversed.
 */
export function buildBreachEdgeGeometry(seed: number, R: number, opts: { inboard?: boolean; mirrorX?: boolean } = {}): { geometry: THREE.BufferGeometry; info: BreachEdgeInfo } {
  const rnd = stream(seed);
  const N = 48;
  const bend = opts.inboard ? 1 : -1;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const pushV = (x: number, y: number, z: number, c: readonly number[]) => { pos.push(x, y, z); col.push(c[0], c[1], c[2]); return pos.length / 3 - 1; };
  const wallTop = 0.012 * -bend;
  const wallBot = BREACH_RIM_DEPTH * bend + 0.012 * -bend;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU;
    const r = breachRadiusAt(th, seed, R);
    const cx = Math.cos(th), cy = Math.sin(th);
    const lip = r + 0.03 + 0.03 * rnd();
    const a = pushV(cx * r, cy * r, wallTop, TORN);
    const b = pushV(cx * r, cy * r, wallBot, TORN);
    const c = pushV(cx * lip, cy * lip, wallTop * 0.6, CHAR);
    const d = pushV(cx * r, cy * r, wallTop * 0.6, CHAR);
    const n = ((i + 1) % N) * 4;
    const [a2, b2, c2, d2] = [n, n + 1, n + 2, n + 3];
    idx.push(a, b, b2, a, b2, a2); // wall
    idx.push(d, c, c2, d, c2, d2); // charred lip
  }
  const rim = new THREE.BufferGeometry();
  rim.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rim.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  rim.setIndex(idx);

  const parts: THREE.BufferGeometry[] = [rim];
  const info: BreachEdgeInfo = { plankEnds: [], splinters: 0 };
  const ends = 5 + Math.floor(rnd() * 5);
  for (let k = 0; k < ends; k++) {
    // Planks run along x: they break at the fore and aft ends of the wound.
    const th = (k % 2 ? Math.PI : 0) + (rnd() - 0.5) * 1.5;
    const r = breachRadiusAt(th, seed, R);
    const len = (0.35 + 0.35 * rnd()) * R + 0.05;
    const w = 0.06 + 0.06 * rnd();
    const box = new THREE.BoxGeometry(len, w, 0.045, 1, 3, 1);
    // Serrated tip: every tip vertex pulled back by its own amount.
    const p = box.attributes.position;
    for (let v = 0; v < p.count; v++) {
      if (p.getX(v) > 0) p.setX(v, len * 0.5 - len * 0.45 * Math.abs(Math.sin(p.getY(v) * 61 + k * 2.3 + seed * 17)));
    }
    box.translate(len * 0.5, 0, 0);
    const bendDeg = 20 + 30 * rnd();
    // Root on the outline, pointing at the centre, tip bent off the face.
    const dir = new THREE.Vector3(-Math.cos(th), -Math.sin(th), 0);
    const side = new THREE.Vector3(0, 0, 1).cross(dir).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(side, THREE.MathUtils.degToRad(bendDeg) * -bend));
    const root = new THREE.Vector3(Math.cos(th) * (r + 0.02), Math.sin(th) * (r + 0.02), 0.015 * bend);
    box.applyQuaternion(q).translate(root.x, root.y, root.z);
    const tip = new THREE.Vector3(len, 0, 0).applyQuaternion(q).add(root);
    info.plankEnds.push({ root, tip, bendDeg });
    parts.push(colorize(box.toNonIndexed(), FRESH));
    box.dispose();
  }
  const splinters = 6 + Math.floor(rnd() * 5);
  for (let k = 0; k < splinters; k++) {
    const th = rnd() * TAU;
    const r = breachRadiusAt(th, seed, R);
    const len = 0.07 + 0.1 * rnd();
    const cone = new THREE.ConeGeometry(0.012 + 0.008 * rnd(), len, 3);
    cone.translate(0, len * 0.5, 0);
    // Out of the far face, leaning toward the wound's middle.
    const dir = new THREE.Vector3(-Math.cos(th) * 0.5, -Math.sin(th) * 0.5, bend).normalize();
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    cone.translate(Math.cos(th) * (r + 0.01), Math.sin(th) * (r + 0.01), BREACH_RIM_DEPTH * bend * 0.8);
    parts.push(colorize(cone.toNonIndexed(), TORN));
    cone.dispose();
  }
  info.splinters = splinters;
  // Position + colour only (normals recomputed on the merged edge).
  const flat = parts.map((g) => {
    const src = g.index ? g.toNonIndexed() : g;
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', src.attributes.position);
    out.setAttribute('color', src.attributes.color);
    return out;
  });
  const geometry = mergeGeometries(flat, false)!;
  for (const g of parts) g.dispose();
  if (opts.mirrorX) {
    geometry.scale(-1, 1, 1);
    for (const e of info.plankEnds) { e.root.x *= -1; e.tip.x *= -1; }
  }
  geometry.computeVertexNormals();
  return { geometry, info };
}

/**
 * The carpenter's repair, outboard: 2 planks (size 1) or 3 laid ALONG the
 * strake, together as tall as the wound plus a margin and as long as the
 * wound + 0.15 m, staggered like real planking, with two nails at each end of
 * every plank. Frame space (x = strake). Two geometries: planks, nails.
 */
export function buildBreachPatchGeometry(seed: number, R: number, size: number) {
  const rnd = stream(seed + 0.5);
  const ext = breachExtent(seed, R);
  const count = size >= 2 ? 3 : 2;
  const len = ext.along * 2 + 0.15;
  const h = (ext.across * 2 + 0.08) / count;
  const planks: THREE.BufferGeometry[] = [];
  const nails: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const y = (i - (count - 1) / 2) * h;
    const l = len + (rnd() - 0.5) * 0.08;
    const x = (rnd() - 0.5) * 0.06;
    const z = 0.02 + (i % 2) * 0.008;
    planks.push(new THREE.BoxGeometry(l, h * 0.94, 0.045).translate(x, y, z));
    for (const sx of [-1, 1]) {
      for (const dy of [-0.28, 0.28]) {
        nails.push(new THREE.CylinderGeometry(0.014, 0.016, 0.012, 6)
          .rotateX(Math.PI / 2)
          .translate(x + sx * (l * 0.5 - 0.05), y + dy * h, z + 0.026));
      }
    }
  }
  const out = { planks: mergeGeometries(planks)!, nails: mergeGeometries(nails)!, count, len, height: h * count };
  for (const g of [...planks, ...nails]) g.dispose();
  return out;
}
