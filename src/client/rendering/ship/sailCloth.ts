import * as THREE from 'three';
import type { RenderQuality } from '../Renderer.js';

// Sail cloth v2 (b4.2g, finding ships-03). The square sails are a flat grid
// whose shape is computed in the VERTEX SHADER every frame: a belly signed by
// the apparent wind against the trim (taken aback flips it to the forward
// face), a leech/foot flutter when the canvas is depowered or luffing, and a
// hoist that gathers the cloth into folds under the yard instead of squashing
// it with scale.y. Normals are analytic (the derivatives of the same surface),
// so there is no CPU loop and no computeVertexNormals per frame. Chainshot
// damage cuts alpha holes from sailIntegrity in the fragment shader.
//
// clothSurface() below is the JS mirror of the GLSL, term for term. The pure
// gate scripts/test-sail-cloth-model.mjs grades the model through it.

/** Belly depth at full fill, as a fraction of the chord (the yard spread). */
export const SAIL_BELLY = 0.125;
/** Exponential rate (1/s) the drawn fill chases its target; a full reversal
 *  (taken aback) crosses zero in ~0.1 s and reaches 90% in ~0.33 s. */
export const SAIL_FILL_RATE = 7;
/** A luffing sail (inside the no-go cone) holds at most this much fill. */
export const SAIL_LUFF_FILL_CAP = 0.1;
/** Flutter amplitude band, fraction of the chord, light air -> strong wind. */
export const SAIL_FLUTTER_MIN = 0.02;
export const SAIL_FLUTTER_MAX = 0.04;
/** Flutter frequency band (Hz), light air -> strong wind. */
export const SAIL_FLUTTER_HZ_MIN = 3;
export const SAIL_FLUTTER_HZ_MAX = 6;
/** Hoist folds: count down the gathered cloth, and depth per unit of
 *  un-hoisted height. */
export const SAIL_FOLDS = 7;
export const SAIL_FOLD_GAIN = 0.05;
/** Facing below which the sail is edge-on to the apparent wind (no fill). */
const FACING_BAND = 0.2;
/** Normaliser so the vertical belly profile s(1-s)^1.5 peaks at 1 when s = 0.4
 *  (max depth 40% down from the head). */
const V_NORM = 0.4 * Math.pow(0.6, 1.5);

/** Grid per LOD tier: LOD0 24x16 (high/balanced), 12x8 on the low tier;
 *  the LOD1 instanced sail 12x8, LOD2 6x4, far a card. */
export const SAIL_CLOTH_GRID = {
  lod0: [24, 16],
  lod0Low: [12, 8],
  lod1: [12, 8],
  lod2: [6, 4],
} as const;

export function sailClothGrid(quality: RenderQuality): readonly [number, number] {
  return quality === 'low' ? SAIL_CLOTH_GRID.lod0Low : SAIL_CLOTH_GRID.lod0;
}

/** 0..1 share of a full belly the apparent wind can blow (monotonic, 0 at 0 m/s,
 *  0.8 at 8 m/s, 0.95 at a 15 m/s fresh breeze). */
export function sailWind01(apparentSpeed: number): number {
  const v = Number.isFinite(apparentSpeed) ? Math.max(0, apparentSpeed) : 0;
  return 1 - Math.exp(-v / 5);
}

/**
 * Signed fill target in -1..1. `localYaw` is the apparent wind in the ship
 * frame (the direction it blows TOWARD, apparentWindLocal), `sailYaw` the
 * yard's drawn brace (the trim pivot's rotation.y, so the sail normal is
 * (sin, 0, cos) of it). Positive = belly toward the sail's +Z (drawing);
 * negative = taken aback (wind on the forward face, belly toward -Z).
 * Drawing fill is wind x trimCatch x facing; aback is wind x facing (trim
 * does not help a sail with the wind on the wrong face). Luffing caps |fill|.
 */
export function sailFillTarget(
  localYaw: number,
  apparentSpeed: number,
  sailYaw: number,
  trimCatch: number,
  luffing: boolean,
): number {
  const w01 = sailWind01(apparentSpeed);
  const dotN = Math.cos(localYaw - sailYaw);
  const facing = Math.max(-1, Math.min(1, (Number.isFinite(dotN) ? dotN : 0) / FACING_BAND));
  const c = Number.isFinite(trimCatch) ? Math.max(0, Math.min(1, trimCatch)) : 0;
  let fill = facing >= 0 ? w01 * c * facing : w01 * facing;
  if (luffing) fill = Math.max(-SAIL_LUFF_FILL_CAP, Math.min(SAIL_LUFF_FILL_CAP, fill));
  return fill;
}

/** Chase the drawn fill toward its target (frame-rate independent). */
export function stepSailFill(current: number, target: number, dt: number): number {
  const c = Number.isFinite(current) ? current : 0;
  const k = 1 - Math.exp(-SAIL_FILL_RATE * Math.max(0, Math.min(0.25, dt)));
  return c + (target - c) * k;
}

/** 0..1 flutter share: full when luffing, else it grows as the fill dies. */
export function sailLuff01(fill: number, luffing: boolean): number {
  if (luffing) return 1;
  const slack = 1 - Math.min(1, Math.abs(fill) / 0.5);
  return slack * slack;
}

export interface SailClothParams {
  fill: number;
  luff: number;
  hoist: number;
  time: number;
  phase: number;
  wind01: number;
  headW: number;
  footW: number;
  height: number;
  chord: number;
}

export interface ClothPoint { y: number; z: number; nx: number; ny: number; nz: number }

/**
 * JS mirror of the vertex shader. (x, y) is the REST position on the flat
 * grid (centred, head at +height/2; x already tapered for a topsail). Returns
 * the drawn y (hoist), the displacement z and the analytic unit normal.
 */
export function clothSurface(x: number, y: number, p: SailClothParams, out: ClothPoint): ClothPoint {
  const H = Math.max(0.01, p.height);
  const hoist = Math.max(0.02, Math.min(1, p.hoist));
  const s = Math.max(0, Math.min(1, (H * 0.5 - y) / H));
  const hw = Math.max(0.05, 0.5 * (p.headW + (p.footW - p.headW) * s));
  const hwp = 0.5 * (p.footW - p.headW);
  const u = Math.max(-1, Math.min(1, x / hw));
  const om = 1 - s;
  const V = (s * Math.pow(om, 1.5)) / V_NORM;
  const Vp = (Math.pow(om, 1.5) - 1.5 * s * Math.sqrt(om)) / V_NORM;
  const B = 1 - u * u;
  const D = p.fill * SAIL_BELLY * p.chord * hoist;
  const w = Math.max(0, Math.min(1, p.wind01));
  const A = p.chord * (SAIL_FLUTTER_MIN + (SAIL_FLUTTER_MAX - SAIL_FLUTTER_MIN) * w) * p.luff * Math.min(1, 4 * w) * hoist;
  const omega = 2 * Math.PI * (SAIL_FLUTTER_HZ_MIN + (SAIL_FLUTTER_HZ_MAX - SAIL_FLUTTER_HZ_MIN) * w);
  const th = omega * p.time - 1.2 * Math.PI * u + 1.7 * s + p.phase;
  const sn = Math.sin(th), cs = Math.cos(th);
  const Pf = s * (2 - s), Pfp = 2 - 2 * s;
  const E = 0.35 + 0.65 * u * u, Ep = 1.3 * u;
  const G = (1 - hoist) * H * SAIL_FOLD_GAIN;
  const fa = Math.PI * SAIL_FOLDS * s;
  const Fo = 1 - 0.3 * u * u;
  const F = D * V * B + A * sn * Pf * E + G * Math.sin(fa) * Fo;
  const Fu = D * V * (-2 * u) + A * Pf * (cs * (-1.2 * Math.PI) * E + sn * Ep) + G * Math.sin(fa) * (-0.6 * u);
  const Fs = D * Vp * B + A * E * (cs * 1.7 * Pf + sn * Pfp) + G * Math.PI * SAIL_FOLDS * Math.cos(fa) * Fo;
  const dzdx = Fu / hw;
  const dzds = Fs + Fu * (-u * hwp / hw);
  const dzdy = dzds / (-H * hoist);
  const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
  out.y = H * 0.5 - s * H * hoist;
  out.z = F;
  out.nx = -dzdx * inv; out.ny = -dzdy * inv; out.nz = inv;
  return out;
}

function clothHash(x: number, y: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function clothNoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = clothHash(ix, iy), b = clothHash(ix + 1, iy), c = clothHash(ix, iy + 1), d = clothHash(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/** Tear threshold the fragment shader compares the hole noise against. */
export function sailTearAmount(sailIntegrity: number): number {
  const i = Number.isFinite(sailIntegrity) ? Math.max(0, Math.min(1, sailIntegrity)) : 1;
  return (1 - i) * 0.32;
}

/** JS mirror of the fragment alpha cut: true = a hole at (u01 across, s down).
 *  The bolt-rope border (6%) never tears. */
export function clothTornAt(u01: number, s: number, tear: number, seed: number): boolean {
  if (tear <= 0 || u01 < 0.06 || u01 > 0.94 || s < 0.06 || s > 0.94) return false;
  return clothNoise(u01 * 5 + seed, s * 7 + seed * 0.37) < tear;
}

/**
 * The flat grid for one square sail (topsail taper applied). The rest z is
 * the FULL-FILL belly, so bounds, the ID pass and any non-shader consumer see
 * a drawing sail; the shader replaces z every frame. Normals are the
 * analytic ones of that rest pose; the bounding sphere covers aback + folds.
 */
export function makeSailClothGeometry(headW: number, footW: number, height: number, segX: number, segY: number): THREE.BufferGeometry {
  const chord = Math.max(headW, footW);
  const geo = new THREE.PlaneGeometry(chord, height, segX, segY);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const p: SailClothParams = { fill: 1, luff: 0, hoist: 1, time: 0, phase: 0, wind01: 1, headW, footW, height, chord };
  const pt: ClothPoint = { y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const s = Math.max(0, Math.min(1, (height * 0.5 - y) / height));
    const x = pos.getX(i) * (headW + (footW - headW) * s) / chord;
    clothSurface(x, y, p, pt);
    pos.setXYZ(i, x, y, pt.z);
    nrm.setXYZ(i, pt.nx, pt.ny, pt.nz);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const reach = SAIL_BELLY * chord * 1.1 + SAIL_FLUTTER_MAX * chord + SAIL_FOLD_GAIN * height;
  geo.boundingBox!.min.z = -reach; geo.boundingBox!.max.z = reach;
  geo.boundingSphere!.radius += reach;
  return geo;
}

/** Per-sail uniforms (one cloned material per sail, so these are its own). */
export interface SailClothUniforms {
  uCloth0: { value: THREE.Vector4 }; // fill, luff, hoist, time
  uCloth1: { value: THREE.Vector4 }; // headW, footW, height, chord
  uCloth2: { value: THREE.Vector4 }; // phase, wind01, tear, seed
}

const CLOTH_COMMON = /* glsl */ `
uniform vec4 uCloth0;
uniform vec4 uCloth1;
uniform vec4 uCloth2;
varying vec2 vClothUv;
`;

const CLOTH_VERTEX = /* glsl */ `
  float clH = max(0.01, uCloth1.z);
  float clHoist = clamp(uCloth0.z, 0.02, 1.0);
  float clS = clamp((clH * 0.5 - position.y) / clH, 0.0, 1.0);
  float clHw = max(0.05, 0.5 * (uCloth1.x + (uCloth1.y - uCloth1.x) * clS));
  float clHwp = 0.5 * (uCloth1.y - uCloth1.x);
  float clU = clamp(position.x / clHw, -1.0, 1.0);
  float clOm = 1.0 - clS;
  float clV = clS * pow(clOm, 1.5) / ${V_NORM.toFixed(8)};
  float clVp = (pow(clOm, 1.5) - 1.5 * clS * sqrt(clOm)) / ${V_NORM.toFixed(8)};
  float clB = 1.0 - clU * clU;
  float clD = uCloth0.x * ${SAIL_BELLY.toFixed(6)} * uCloth1.w * clHoist;
  float clW = clamp(uCloth2.y, 0.0, 1.0);
  float clA = uCloth1.w * (${SAIL_FLUTTER_MIN.toFixed(6)} + ${(SAIL_FLUTTER_MAX - SAIL_FLUTTER_MIN).toFixed(6)} * clW) * uCloth0.y * min(1.0, 4.0 * clW) * clHoist;
  float clOmega = 6.28318531 * (${SAIL_FLUTTER_HZ_MIN.toFixed(4)} + ${(SAIL_FLUTTER_HZ_MAX - SAIL_FLUTTER_HZ_MIN).toFixed(4)} * clW);
  float clTh = clOmega * uCloth0.w - 3.76991118 * clU + 1.7 * clS + uCloth2.x;
  float clSn = sin(clTh);
  float clCs = cos(clTh);
  float clPf = clS * (2.0 - clS);
  float clPfp = 2.0 - 2.0 * clS;
  float clE = 0.35 + 0.65 * clU * clU;
  float clEp = 1.3 * clU;
  float clG = (1.0 - clHoist) * clH * ${SAIL_FOLD_GAIN.toFixed(6)};
  float clFa = ${(Math.PI * SAIL_FOLDS).toFixed(8)} * clS;
  float clFo = 1.0 - 0.3 * clU * clU;
  float clF = clD * clV * clB + clA * clSn * clPf * clE + clG * sin(clFa) * clFo;
  float clFu = clD * clV * (-2.0 * clU) + clA * clPf * (clCs * -3.76991118 * clE + clSn * clEp) + clG * sin(clFa) * (-0.6 * clU);
  float clFs = clD * clVp * clB + clA * clE * (clCs * 1.7 * clPf + clSn * clPfp) + clG * ${(Math.PI * SAIL_FOLDS).toFixed(8)} * cos(clFa) * clFo;
  float clDzdx = clFu / clHw;
  float clDzdy = (clFs + clFu * (-clU * clHwp / clHw)) / (-clH * clHoist);
  vec3 clothNormal = normalize(vec3(-clDzdx, -clDzdy, 1.0));
  vec3 clothPos = vec3(position.x, clH * 0.5 - clS * clH * clHoist, clF);
  vClothUv = vec2(clU * 0.5 + 0.5, clS);
`;

const CLOTH_FRAGMENT = /* glsl */ `
  if (uCloth2.z > 0.0 && vClothUv.x > 0.06 && vClothUv.x < 0.94 && vClothUv.y > 0.06 && vClothUv.y < 0.94) {
    vec2 clP = vec2(vClothUv.x * 5.0 + uCloth2.w, vClothUv.y * 7.0 + uCloth2.w * 0.37);
    vec2 clI = floor(clP);
    vec2 clF2 = fract(clP);
    clF2 = clF2 * clF2 * (3.0 - 2.0 * clF2);
    float clA0 = fract(sin(dot(clI, vec2(127.1, 311.7))) * 43758.5453);
    float clA1 = fract(sin(dot(clI + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float clA2 = fract(sin(dot(clI + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float clA3 = fract(sin(dot(clI + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float clN = mix(mix(clA0, clA1, clF2.x), mix(clA2, clA3, clF2.x), clF2.y);
    if (clN < uCloth2.z) discard;
  }
`;

/**
 * Turn a (cloned, per-sail) MeshStandardMaterial into GPU cloth. All sails
 * share one program (constant cache key); each keeps its own uniforms.
 */
export function attachSailCloth(
  material: THREE.MeshStandardMaterial,
  headW: number,
  footW: number,
  height: number,
  phase: number,
): SailClothUniforms {
  const uniforms: SailClothUniforms = {
    uCloth0: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCloth1: { value: new THREE.Vector4(headW, footW, height, Math.max(headW, footW)) },
    uCloth2: { value: new THREE.Vector4(phase, 0, 0, (phase * 3.17) % 11) },
  };
  material.userData.sailCloth = uniforms;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloth0 = uniforms.uCloth0;
    shader.uniforms.uCloth1 = uniforms.uCloth1;
    shader.uniforms.uCloth2 = uniforms.uCloth2;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CLOTH_COMMON}`)
      .replace('#include <beginnormal_vertex>', `${CLOTH_VERTEX}\n  vec3 objectNormal = clothNormal;\n#ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n#endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = clothPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CLOTH_COMMON}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CLOTH_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => 'sail-cloth-v2';
  return uniforms;
}

/** Per-frame write of one sail's cloth state (allocation-free). */
export function setSailClothUniforms(
  u: SailClothUniforms,
  fill: number,
  luff: number,
  hoist: number,
  time: number,
  wind01: number,
  sailIntegrity: number,
): void {
  u.uCloth0.value.set(fill, luff, hoist, time);
  u.uCloth2.value.y = wind01;
  u.uCloth2.value.z = sailTearAmount(sailIntegrity);
}

/**
 * Unit sail card for the instanced LOD sails (scaled per instance to each
 * yard): a static forward belly in metres, max at 40% down from the head like
 * the LOD0 cloth. LOD1 12x8, LOD2 6x4 (SAIL_CLOTH_GRID). Built once.
 */
export function makeLodSailCard(segX: number, segY: number, bellyM: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1, 1, segX, segY);
  const sp = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const u = sp.getX(i) / 0.5;
    const s = Math.max(0, Math.min(1, 0.5 - sp.getY(i)));
    sp.setZ(i, bellyM * (1 - u * u) * (s * Math.pow(1 - s, 1.5)) / V_NORM);
  }
  geo.computeVertexNormals();
  return geo;
}
