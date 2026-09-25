// THE HOLD WATER (b2.3a, holes-01 / liveplay-01).
//
// The water in a holed hull is a free surface that stays level in the WORLD
// while the hull rolls and trims around it, so in the hull's own frame it is a
// tilted plane: deeper on the low rail, deeper at a dipped bow. The old sheet
// was a 6x8 plane glued to the hull (it tilted WITH the deck), its height was
// linear in the fill and jumped to the deck at a literal 0.8, and it was a
// near-black slab in an unlit hold. This module owns all of it:
//
//   - HEIGHT from the shared fill-to-height table (src/shared/flooding/
//     hullVolume.ts, the same numbers the server floods and wades with), so
//     the surface meets the deck underside exactly at fill 1.0.
//   - TILT from the drawn hull attitude (world-level water, the formula of
//     holdWaterSurfaceLocalY) plus the DYNAMIC slosh: the client re-simulates
//     the shared 2-DOF slosh (stepSlosh) from the replicated attitude and adds
//     the centroid's deviation from its static target as a surface slope
//     (a wedge of slope s moves the centroid s b^2 / (12 d)).
//   - CLIP per fragment to the loft half-width table (stations x heights,
//     bilinear, the same numbers clipHalfWidth returns in node) and to the
//     sole/deck band, so a tilted sheet never pokes through the planking.
//   - LOOK: depth-tinted colour (shallow teal over the sole, deep green-black),
//     a Fresnel sky/lantern sheen, a scrolling ripple normal, a wet contact
//     line where the water meets the lining, foam rings fed by hooks
//     (setHoldWaterFoam; b2.3b feeds the jets) and a murky underside when the
//     eye is below the surface.
//   - LIGHT from the fixed pool only: the water carries its own lantern-lit
//     emissive floor (the hold lanterns are emissive, not lights) and a
//     hatch light shaft falls through the companionway by day. No PointLight.
//
// Grids 24x12 (high) / 12x6 (balanced) / 6x4 (low); the low tier is a flat
// sheet fitted to the loft on the CPU with no fragment clip and no ripple.
// Cost: 2 draws per flooded hull (water + shaft), the shaft only by day.
import * as THREE from 'three';
import type { ShipType } from '../../../shared/types/index.js';
import { SHIP_STATS } from '../../../shared/constants/index.js';
import { getHullProfile, hullSurfacePointAt } from '../../../shared/hull.js';
import { getHullVolumeTable, fillToLocalY } from '../../../shared/flooding/hullVolume.js';
import {
  newSloshState, sloshGeometry, sloshTargetX, sloshTargetZ, stepSlosh, type SloshState,
} from '../../../shared/flooding/slosh.js';
import { getShipCompanionwayConfig } from '../../../shared/utils/index.js';

export type HoldWaterQuality = 'low' | 'balanced' | 'high';

/** Loft half-width table: stations along the hold x heights sole..deck. */
export const HOLD_WATER_STATIONS = 16;
export const HOLD_WATER_LEVELS = 6;
/** The lining stands this far inboard of the loft skin (planking + frames). */
export const HOLD_WATER_INSET = 0.06;
/** Share of the hull length the hold runs (matches hullVolume's HOLD_LENGTH_F). */
const HOLD_LENGTH_F = 0.9;
/** A hull steeper than this (cos pitch x cos roll) has no meaningful level. */
const MIN_UPRIGHT = 0.2;
/** Largest extra slope (m/m) the dynamic slosh adds on top of the level. */
const MAX_SLOSH_SLOPE = 0.22;

/** Grid resolution (segments along the length, across the beam) per tier. */
export function holdWaterGrid(quality: HoldWaterQuality): { along: number; across: number } {
  if (quality === 'high') return { along: 24, across: 12 };
  if (quality === 'balanced') return { along: 12, across: 6 };
  return { along: 6, across: 4 };
}

export interface HoldWaterClip {
  type: ShipType;
  soleY: number;
  deckY: number;
  /** Half the hold length; stations run -halfL..+halfL evenly. */
  halfL: number;
  /** halfWidth[s * LEVELS + l], lining half-width (loft minus inset), >= 0. */
  halfWidth: Float32Array;
  /** Widest entry (sizes the grid). */
  maxHalfWidth: number;
}

const CLIPS = new Map<ShipType, HoldWaterClip>();

export function buildHoldWaterClip(type: ShipType): HoldWaterClip {
  const cached = CLIPS.get(type);
  if (cached) return cached;
  const vt = getHullVolumeTable(type);
  const profile = getHullProfile(type);
  const halfL = profile.L * 0.5 * HOLD_LENGTH_F;
  const halfWidth = new Float32Array(HOLD_WATER_STATIONS * HOLD_WATER_LEVELS);
  let maxHalfWidth = 0;
  for (let s = 0; s < HOLD_WATER_STATIONS; s += 1) {
    const z = -halfL + (2 * halfL * s) / (HOLD_WATER_STATIONS - 1);
    for (let l = 0; l < HOLD_WATER_LEVELS; l += 1) {
      const y = vt.soleY + ((vt.deckY - vt.soleY) * l) / (HOLD_WATER_LEVELS - 1);
      // The skin is convex between samples in y, so the chord of two samples
      // lies inside it; the inset covers the curvature between stations.
      const hw = Math.max(0, hullSurfacePointAt(profile, z, y).x - HOLD_WATER_INSET);
      halfWidth[s * HOLD_WATER_LEVELS + l] = hw;
      if (hw > maxHalfWidth) maxHalfWidth = hw;
    }
  }
  const clip: HoldWaterClip = { type, soleY: vt.soleY, deckY: vt.deckY, halfL, halfWidth, maxHalfWidth };
  CLIPS.set(type, clip);
  return clip;
}

/** Lining half-width at hull-local (z, y); -1 outside the hold's length or band.
 *  Bit-for-bit the lookup the fragment shader does. */
export function clipHalfWidth(clip: HoldWaterClip, z: number, y: number): number {
  if (!(Math.abs(z) <= clip.halfL) || !(y >= clip.soleY) || !(y <= clip.deckY)) return -1;
  const fs = ((z + clip.halfL) / (2 * clip.halfL)) * (HOLD_WATER_STATIONS - 1);
  const fl = ((y - clip.soleY) / (clip.deckY - clip.soleY)) * (HOLD_WATER_LEVELS - 1);
  const s0 = Math.min(HOLD_WATER_STATIONS - 2, Math.floor(fs));
  const l0 = Math.min(HOLD_WATER_LEVELS - 2, Math.floor(fl));
  const us = fs - s0; const ul = fl - l0;
  const w = clip.halfWidth;
  const a = w[s0 * HOLD_WATER_LEVELS + l0] + (w[s0 * HOLD_WATER_LEVELS + l0 + 1] - w[s0 * HOLD_WATER_LEVELS + l0]) * ul;
  const b = w[(s0 + 1) * HOLD_WATER_LEVELS + l0]
    + (w[(s0 + 1) * HOLD_WATER_LEVELS + l0 + 1] - w[(s0 + 1) * HOLD_WATER_LEVELS + l0]) * ul;
  return a + (b - a) * us;
}

/** Hull-local surface: y = y0 + sx x + sz z. */
export interface HoldWaterPlane { y0: number; sx: number; sz: number }

/**
 * The hold-water plane in the hull frame for a volume fill and the drawn
 * attitude (+roll lifts +x, +pitch dips the bow), plus the dynamic slosh
 * slopes. Null when dry or when the hull is on her beam ends.
 */
export function holdWaterPlane(
  type: ShipType, fill: number, roll: number, pitch: number, sloshSx = 0, sloshSz = 0,
): HoldWaterPlane | null {
  if (!(fill > 0.001)) return null;
  const y0 = fillToLocalY(type, fill);
  const r = Number.isFinite(roll) ? roll : 0;
  const p = Number.isFinite(pitch) ? pitch : 0;
  const cp = Math.cos(p);
  const k = cp * Math.cos(r);
  if (!(k > MIN_UPRIGHT)) return { y0, sx: 0, sz: 0 };
  return {
    y0,
    sx: -(cp * Math.sin(r)) / k + clampAbs(sloshSx, MAX_SLOSH_SLOPE),
    sz: Math.sin(p) / k + clampAbs(sloshSz, MAX_SLOSH_SLOPE),
  };
}

function clampAbs(v: number, m: number): number {
  return Number.isFinite(v) ? Math.max(-m, Math.min(m, v)) : 0;
}

export function planeY(plane: HoldWaterPlane, x: number, z: number): number {
  return plane.y0 + plane.sx * x + plane.sz * z;
}

/** Is the hull-local point (x, z) on the drawn water (inside the clip)? */
export function holdWaterCovers(clip: HoldWaterClip, plane: HoldWaterPlane, x: number, z: number): boolean {
  const y = planeY(plane, x, z);
  const hw = clipHalfWidth(clip, z, y);
  return hw >= 0 && Math.abs(x) <= hw;
}

// ── Client slosh re-sim ──────────────────────────────────────────────────────

export interface HoldSloshSim { state: SloshState; fill: number }

export function newHoldSloshSim(): HoldSloshSim {
  return { state: newSloshState(), fill: 0 };
}

/**
 * Advance the client's copy of the shared slosh from the drawn attitude and
 * return the DYNAMIC slopes (deviation of the centroid from where a still
 * surface would put it). The remembered-inflow offset and the static list are
 * already in the replicated attitude, so they are not added twice: the memory
 * is held at 0 and the hull is given an effectively infinite righting
 * stiffness, which leaves exactly the free-surface target and its oscillator.
 */
export function stepHoldSlosh(
  sim: HoldSloshSim, type: ShipType, fill: number, roll: number, pitch: number, dt: number,
): { sx: number; sz: number } {
  const f = Math.min(1, Math.max(0, fill));
  const hull = { type, fill: f, mass: 1, kRoll: 1e12, roll, pitch };
  const step = Math.min(0.05, Math.max(0, dt));
  stepSlosh(sim.state, hull, step, sim.fill);
  sim.fill = f;
  sim.state.memX = 0; sim.state.memZ = 0;
  if (!(f > 1e-3)) return { sx: 0, sz: 0 };
  const g = sloshGeometry(type, f);
  const d = Math.max(0.05, g.d);
  const dx = sim.state.x - sloshTargetX(g, hull, 0);
  const dz = sim.state.z - sloshTargetZ(g, hull, 0);
  return {
    sx: clampAbs((dx * 12 * d) / (g.b * g.b), MAX_SLOSH_SLOPE),
    sz: clampAbs((dz * 12 * d) / (g.l * g.l), MAX_SLOSH_SLOPE),
  };
}

// ── Mesh ─────────────────────────────────────────────────────────────────────

const MAX_FOAM = 4;

export interface HoldWaterHandle {
  mesh: THREE.Mesh;
  shaft: THREE.Mesh;
  type: ShipType;
  quality: HoldWaterQuality;
  clip: HoldWaterClip;
  sim: HoldSloshSim;
  uniforms: {
    uPlane: { value: THREE.Vector3 };
    uTime: { value: number };
    uAgitation: { value: number };
    uFoam: { value: THREE.Vector4[] };
  };
  /** The low tier fits its sheet on the CPU; the rest in the vertex shader. */
  cpuBase: Float32Array | null;
  /** Last plane drawn (read by probes and the underwater tint, b2.3f). */
  plane: HoldWaterPlane | null;
  fill: number;
}

const SHAFT_COLOR = new THREE.Color(0xfff1c8);

export function createHoldWater(type: ShipType, quality: HoldWaterQuality): HoldWaterHandle {
  const clip = buildHoldWaterClip(type);
  const grid = holdWaterGrid(quality);
  const geo = new THREE.PlaneGeometry(2 * (clip.maxHalfWidth + 0.02), 2 * clip.halfL, grid.across, grid.along);
  geo.rotateX(-Math.PI * 0.5);
  let cpuBase: Float32Array | null = null;
  if (quality === 'low') {
    // Flat sheet, no fragment clip: fit every row to the lining at mid-hold
    // height (the narrowest band the sheet spends its life in).
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const midY = clip.soleY + (clip.deckY - clip.soleY) * 0.35;
    for (let i = 0; i < pos.count; i += 1) {
      const z = pos.getZ(i);
      const hw = Math.max(0.1, clipHalfWidth(clip, Math.max(-clip.halfL, Math.min(clip.halfL, z)), midY));
      pos.setX(i, Math.sign(pos.getX(i)) * Math.min(Math.abs(pos.getX(i)), hw));
    }
    cpuBase = Float32Array.from(pos.array as Float32Array);
  }
  const uniforms = {
    uPlane: { value: new THREE.Vector3(clip.soleY, 0, 0) },
    uTime: { value: 0 },
    uAgitation: { value: 1 },
    uFoam: { value: Array.from({ length: MAX_FOAM }, () => new THREE.Vector4(0, 0, 0, 0)) },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0x23666c,
    roughness: 0.12,
    metalness: 0.0,
    emissive: 0x0a2c30,
    emissiveIntensity: 1,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
  mat.name = 'hold-water';
  const clipped = quality !== 'low';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uClip: { value: clip.halfWidth },
      uClipBox: { value: new THREE.Vector4(clip.halfL, clip.soleY, clip.deckY, 0) },
    });
    shader.defines = { ...(shader.defines ?? {}), HW_S: HOLD_WATER_STATIONS, HW_L: HOLD_WATER_LEVELS, HW_FOAM: MAX_FOAM };
    if (clipped) shader.defines.HW_CLIP = 1;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform vec3 uPlane;
uniform float uTime;
uniform float uAgitation;
varying vec3 vHold;
varying vec3 vHoldT;
varying vec3 vHoldB;`)
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal = normalize(vec3(-uPlane.y, 1.0, -uPlane.z));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
transformed.y = uPlane.x + uPlane.y * position.x + uPlane.z * position.z;
vHold = transformed;
vHoldT = normalize(normalMatrix * vec3(1.0, uPlane.y, 0.0));
vHoldB = normalize(normalMatrix * vec3(0.0, uPlane.z, 1.0));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uClip[HW_S * HW_L];
uniform vec4 uClipBox;
uniform vec3 uPlane;
uniform float uTime;
uniform float uAgitation;
uniform vec4 uFoam[HW_FOAM];
varying vec3 vHold;
varying vec3 vHoldT;
varying vec3 vHoldB;
float hwAt(int s, int l) { return uClip[s * HW_L + l]; }
float holdHalfWidth(float z, float y) {
  float fs = clamp((z + uClipBox.x) / (2.0 * uClipBox.x), 0.0, 1.0) * float(HW_S - 1);
  float fl = clamp((y - uClipBox.y) / (uClipBox.z - uClipBox.y), 0.0, 1.0) * float(HW_L - 1);
  int s0 = int(min(float(HW_S - 2), floor(fs)));
  int l0 = int(min(float(HW_L - 2), floor(fl)));
  float us = fs - float(s0); float ul = fl - float(l0);
  float a = mix(hwAt(s0, l0), hwAt(s0, l0 + 1), ul);
  float b = mix(hwAt(s0 + 1, l0), hwAt(s0 + 1, l0 + 1), ul);
  return mix(a, b, us);
}
vec2 holdRipple(vec2 p) {
  // Gradient of a few crossing wavelets (m/m), scaled by agitation.
  float t = uTime;
  vec2 g = vec2(0.0);
  g += vec2(0.9, 0.4) * cos(dot(p, vec2(0.9, 0.4)) * 4.1 + t * 1.9);
  g += vec2(-0.3, 1.0) * cos(dot(p, vec2(-0.3, 1.0)) * 5.3 - t * 2.3);
  g += vec2(0.7, -0.75) * cos(dot(p, vec2(0.7, -0.75)) * 7.7 + t * 3.1) * 0.6;
  return g * 0.035 * uAgitation;
}`)
      .replace('void main() {', `void main() {
  float holdHw = 1e3;
#ifdef HW_CLIP
  if (abs(vHold.z) > uClipBox.x || vHold.y < uClipBox.y || vHold.y > uClipBox.z) discard;
  holdHw = holdHalfWidth(vHold.z, vHold.y);
  if (abs(vHold.x) > holdHw) discard;
#endif
  float holdDepth = max(0.0, vHold.y - uClipBox.y);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  // Shallow water over the sole reads teal; deep water goes green-black.
  float deepT = clamp(holdDepth / 1.6, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.22, 0.24), deepT * 0.7);
  // Wet contact line where the surface meets the lining, and foam rings.
  float edge = 1.0 - smoothstep(0.0, 0.14, holdHw - abs(vHold.x));
  float foam = edge * 0.55;
  for (int i = 0; i < HW_FOAM; i++) {
    vec4 f = uFoam[i];
    if (f.w <= 0.0) continue;
    float d = length(vHold.xz - f.xy);
    float ring = smoothstep(f.z, f.z * 0.55, d) * (0.6 + 0.4 * sin(d * 18.0 - uTime * 6.0));
    foam = max(foam, ring * f.w);
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.9, 0.88), clamp(foam, 0.0, 1.0));
  if (!gl_FrontFacing) {
    // Seen from below: a murky, nearly opaque ceiling of water.
    diffuseColor.rgb = vec3(0.05, 0.2, 0.2);
    diffuseColor.a = 0.97;
  }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
#ifdef HW_CLIP
  vec2 rg = holdRipple(vHold.xz);
  normal = normalize(normal - rg.x * vHoldT - rg.y * vHoldB);
#endif`)
      .replace('#include <opaque_fragment>', `
  // Fresnel: grazing views pick up the sky through the hatch and the lanterns.
  float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);
  outgoingLight = mix(outgoingLight, vec3(0.55, 0.7, 0.72), fres * 0.45);
  // From below, the lamps and the hatch glow through: a lit murk, not a lid.
  if (!gl_FrontFacing) outgoingLight = vec3(0.05, 0.22, 0.23);
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `hold-water-${clipped ? 'clip' : 'flat'}`;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hold-water';
  mesh.visible = false;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false; // the vertex shader moves it; the ship culls as a whole

  // Hatch light shaft: sunlight falling through the companionway onto the
  // water. Additive, unlit, no depth write, hidden at night.
  const stats = SHIP_STATS[type];
  const cw = getShipCompanionwayConfig(stats);
  const shaftH = Math.max(0.5, stats.height - clip.soleY);
  const shaftGeo = new THREE.CylinderGeometry(0.62, 1, shaftH, quality === 'low' ? 4 : 8, 1, true);
  shaftGeo.scale(cw.halfX * 0.9, 1, cw.halfZ * 0.78);
  shaftGeo.translate(cw.cx, clip.soleY + shaftH * 0.5, cw.cz);
  const shaftMat = new THREE.MeshBasicMaterial({
    color: SHAFT_COLOR, transparent: true, opacity: 0.08, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  shaftMat.name = 'hold-hatch-shaft';
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.name = 'hold-hatch-shaft';
  shaft.renderOrder = 2;
  shaft.visible = false;

  return {
    mesh, shaft, type, quality, clip, sim: newHoldSloshSim(), uniforms, cpuBase, plane: null, fill: 0,
  };
}

export interface HoldWaterFrame {
  /** Volume fill 0..1 (1 while foundering). */
  fill: number;
  /** Drawn hull attitude (the root's rotation.z / rotation.x). */
  roll: number;
  pitch: number;
  t: number;
  dt: number;
  sinking: boolean;
  /** 0 noon .. 1 night. */
  night: number;
}

/** Per-frame update. Returns whether the water is drawn. */
export function updateHoldWater(h: HoldWaterHandle, f: HoldWaterFrame): boolean {
  const fill = Math.min(1, Math.max(0, Number.isFinite(f.fill) ? f.fill : 0));
  h.fill = fill;
  const slosh = stepHoldSlosh(h.sim, h.type, fill, f.roll, f.pitch, f.dt);
  const plane = holdWaterPlane(h.type, fill, f.roll, f.pitch, slosh.sx, slosh.sz);
  h.plane = plane;
  const show = plane !== null && fill > 0.02;
  h.mesh.visible = show;
  h.shaft.visible = show && f.night < 0.6;
  if (!plane || !show) return false;
  h.uniforms.uPlane.value.set(plane.y0, plane.sx, plane.sz);
  h.uniforms.uTime.value = f.t;
  h.uniforms.uAgitation.value = 1 + fill * 1.2 + (f.sinking ? 0.75 : 0)
    + Math.min(2, 8 * Math.hypot(slosh.sx, slosh.sz));
  const mat = h.mesh.material as THREE.MeshStandardMaterial;
  // Lantern light on the water: the emissive floor rises at night with the
  // hold lanterns (they are emissive, not lights).
  mat.emissiveIntensity = 0.9 + 0.5 * f.night;
  (h.shaft.material as THREE.MeshBasicMaterial).opacity = 0.08 * (1 - f.night / 0.6);
  return true;
}

/** Foam hooks (b2.3b jets, b2.3g founder): up to 4 rings, hull-local x, z,
 *  radius (m) and strength 0..1. Pass [] to clear. */
export function setHoldWaterFoam(
  h: HoldWaterHandle, rings: ReadonlyArray<{ x: number; z: number; radius: number; strength: number }>,
): void {
  for (let i = 0; i < MAX_FOAM; i += 1) {
    const r = rings[i];
    if (r) h.uniforms.uFoam.value[i].set(r.x, r.z, Math.max(0.05, r.radius), Math.min(1, Math.max(0, r.strength)));
    else h.uniforms.uFoam.value[i].set(0, 0, 0, 0);
  }
}

/** Is a hull-local eye below the drawn surface and inside the hold? (b2.3f) */
export function holdWaterEyeDepth(h: HoldWaterHandle, local: { x: number; y: number; z: number }): number {
  if (!h.plane || !h.mesh.visible) return 0;
  const y = planeY(h.plane, local.x, local.z);
  const hw = clipHalfWidth(h.clip, local.z, Math.min(h.clip.deckY, Math.max(h.clip.soleY, local.y)));
  if (hw < 0 || Math.abs(local.x) > hw + 0.1) return 0;
  return Math.max(0, y - local.y);
}

export function disposeHoldWater(h: HoldWaterHandle): void {
  h.mesh.geometry.dispose();
  (h.mesh.material as THREE.Material).dispose();
  h.shaft.geometry.dispose();
  (h.shaft.material as THREE.Material).dispose();
}
