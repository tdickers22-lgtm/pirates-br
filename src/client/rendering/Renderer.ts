import * as THREE from 'three';
import { PostFx } from './PostFx.js';
import { initLightBudget, updateLightBudget } from './LightBudget.js';
import { freezeStaticParent } from './three-util.js';
import { ProgramWarmer, shaderErrorsForced } from './ProgramWarmup.js';
import { clamp, smoothstep } from '../../shared/utils/index.js';
import { decideRenderQuality, saveAutoTierCeiling, tierBelow, type QualityVerdict, type RenderQuality } from './QualityPreference.js';
import {
  FrameGovernor, resolveLevers, describeGovernor,
  type GovernorLevers, type GovernorMode, type LeverCaps,
} from './FrameGovernor.js';
import { frameBudgetScale, setFrameBudgetScale } from './FrameBudget.js';

export type { RenderQuality };

/**
 * THE PIXEL-RATIO CEILING, per tier.
 *
 * This is the single most expensive number in the client and the least visible
 * one. A Retina panel reports devicePixelRatio 2, and a ratio of 2 is FOUR
 * TIMES the fragments of 1.0 — every fragment of every overdrawn water sheet,
 * every foliage alpha-test, the whole post chain, four times over, for a
 * sharpness difference that on a 224 ppi panel at arm's length is most of the
 * way to invisible. 'high' used to be allowed 1.75 (3.1x the fragments of 1.0)
 * and the machine spent the session ratcheting back down from it while macOS's
 * compositor fought for the same GPU.
 *
 * 1.25 is 1.56x — still visibly crisper than 1.0, and 49% cheaper per frame
 * than 1.75 was. The runtime scaler still moves BELOW these; nothing here stops
 * a good machine from looking good, it stops every machine from opening at a
 * ceiling only a workstation can hold.
 */
const MAX_PIXEL_RATIO: Record<RenderQuality, number> = {
  // Under 1.0 on purpose and unchanged: 'low' has always rendered below native
  // and let the upscale carry it. Raising it to 1.0 in the name of "capping" it
  // would make the cheapest tier more expensive, which is backwards.
  low: 0.62,
  balanced: 1.15,
  high: 1.25,
};

/**
 * DRAW THE NEAR THING FIRST. The one fill lever in this game that changes no
 * pixel of the output.
 *
 * three r160 does NOT sort opaque geometry front-to-back, and this cost me an
 * afternoon of assuming it did. `painterSortStable`
 * (three.module.js:21250) compares `groupOrder`, then `renderOrder`, then
 * **`material.id`**, and only reaches `z` when two draws already share a
 * material. So opaque draw order in this game was *material creation order* —
 * whatever order a constructor happened to declare its materials in — and the
 * depth test spent the whole frame rejecting fragments it had already shaded.
 *
 * Measured, on the parked deck at seed 20260801 (`perf-deck-overdraw
 * --park`, paired census, mutation and baseline in the same task):
 *
 *   low    2.457 → **1.430** layers  (−1.027, −42%)   p95 6 → **3**
 *   high   2.291 → **1.933** layers  (−0.358, −16%)   p95 5 → **4**
 *
 * The tier that needs it most gets the most, which is the opposite of how the
 * quality ladder behaves (§1 of the cost model: the ladder buys geometry, not
 * fill). For scale, deleting every ship in the world was worth −0.359 at `low`
 * in the same session: this is worth nearly three of that, and it deletes
 * nothing.
 *
 * WHY IT IS FREE TO LOOK AT, AND EXACTLY WHERE IT IS NOT. Opaque geometry that
 * both TESTS and WRITES depth composites to the same image in any order — order
 * decides only which shaded fragments are thrown away, and near-first throws
 * away the most. The one place order is observable there is an exact depth tie,
 * where `LESS` keeps whoever drew first; that is z-fighting, a defect wherever
 * it exists and not something this may preserve.
 *
 * **A draw that opts out of the depth buffer is the opposite case, and this
 * game has a whole subsystem of them.** Every viewmodel mesh runs
 * `depthTest: false, depthWrite: false` at renderOrder 999-1004
 * (`applyViewmodelMaterialSettings`), so for those draws the SEQUENCE IS THE
 * PICTURE: the blade, guard, grip and pommel of one cutlass overlap on screen
 * and whichever draws last wins. Near-first is precisely backwards there — it
 * would let the guard behind the blade paint over it — and it is the same
 * failure the HAND_RENDER_ORDER comment in ViewmodelController describes from
 * the other side. So the comparator partitions on "does this draw participate
 * in the depth buffer": participants get z, everything else keeps three's
 * material-id order, byte for byte what it had before. The partition is FIRST,
 * which is what keeps the comparator a total order — two regimes selected
 * pairwise would let a < b < c < a, and Array.sort with an inconsistent
 * comparator has no defined result at all.
 *
 * WHAT IT COSTS. Batching. three's default key is material id precisely to keep
 * same-material draws adjacent, and sorting by depth interleaves them. That is
 * a trade of GL state changes for shaded fragments, and on the machine this game
 * targets — fanless, fill-bound, `low` — the measurement above says which side
 * to take. `groupOrder` and `renderOrder` stay AHEAD of z, so everything that
 * deliberately owns a slot in the order (the sky dome pinned last, the FX
 * layers) keeps it.
 */
interface SortItem {
  groupOrder: number;
  renderOrder: number;
  material: { id: number; depthTest: boolean; depthWrite: boolean };
  z: number;
  id: number;
}

/** Does the depth buffer decide this draw's result? Only then is its position in
 *  the sequence unobservable, and only then may it be moved. */
function ownsDepth(item: SortItem): boolean {
  return item.material.depthTest && item.material.depthWrite;
}

function frontToBack(a: SortItem, b: SortItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const ad = ownsDepth(a);
  const bd = ownsDepth(b);
  if (ad !== bd) return ad ? -1 : 1;
  if (ad) {
    // z is the object origin in NDC (WebGLRenderer.projectObject), so it grows
    // with distance and ascending IS front-to-back.
    if (a.z !== b.z) return a.z - b.z;
    return a.id - b.id;
  }
  // painterSortStable's own tail, unchanged, for everything the depth buffer
  // does not arbitrate.
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

/** Sky dome tessellation per tier — segments, not a cost anyone reads as
 *  quality. See the dome construction below for why the count is not cosmetic;
 *  the short version is that the crease it hides is an artefact of the ramp's
 *  DERIVATIVE, and how coarse you can go before it shows scales with how much
 *  else is on screen. 'low' has always had 48x24 (~2.3k tris); 'high' pays 96x48
 *  (~9.2k) for a dome drawn once, and 'balanced' splits it. */
const SKY_SEGMENTS: Record<RenderQuality, { width: number; height: number }> = {
  low: { width: 48, height: 24 },
  balanced: { width: 64, height: 32 },
  high: { width: 96, height: 48 },
};

const DAY_NIGHT_CYCLE_SECONDS = 960; // slower cycle: dusk is a scene, not a flash
const DAY_NIGHT_START_OFFSET = 0.47;

/**
 * ONE SUNSET PER MATCH.
 *
 * updateDayNight walks a cycle in [0,1): daylight occupies the first 0.72 of it
 * and the sun is on the horizon exactly at 0.72. Run free at 960 s a lap from an
 * 0.47 start and the world reaches dusk four minutes after the horn — a player
 * still finding the helm learns the stations in night rain, and the match's one
 * dramatic light change is spent before the storm's grace period is over.
 *
 * So the cycle is hung on MATCH PROGRESS instead: the horn opens mid-morning
 * (sun climbing, long shadows), noon lands around the middle phases, and the
 * horizon goes red as the late rings close. The endpoints are chosen so the
 * whole arc is exactly one transition — the sun never comes back up.
 */
const MATCH_DAY_CYCLE_START = 0.26;
const MATCH_DAY_CYCLE_END = 0.79;

/** Match progress (0..1) → the elapsed-seconds figure updateDayNight wants, so
 *  the debug override (which speaks in seconds) and the match clock stay one
 *  code path. Exported for the single consumption point in Game. */
export function dayNightSecondsForMatchProgress(progress: number): number {
  const p = clamp(progress, 0, 1);
  const cycle = MATCH_DAY_CYCLE_START + (MATCH_DAY_CYCLE_END - MATCH_DAY_CYCLE_START) * p;
  return (cycle - DAY_NIGHT_START_OFFSET) * DAY_NIGHT_CYCLE_SECONDS;
}

/**
 * Whether the adaptive governor is allowed to touch anything this session.
 *
 * DEFAULT ON. It goes OFF whenever the tier was pinned with `?quality=`,
 * because every measurement rig in this repo pins the tier on purpose and a
 * controller quietly moving the resolution and the LOD radii underneath a
 * census would make every count it took a reading of a different frame. The
 * browser gate that grades the governor ITSELF asks for it back with
 * `?governor=on`; `?governor=off` pins it off anywhere.
 */
function governorEnabledFor(reason: QualityVerdict['reason']): boolean {
  const param = new URLSearchParams(window.location.search).get('governor');
  if (param === 'off' || param === '0') return false;
  if (param === 'on' || param === '1') return true;
  return reason !== 'url';
}

// ── THE DOME SITS ON THE FAR PLANE, NOT IN FRONT OF THE WORLD ────────────────
// v_dir is the object-space direction and is unaffected by what follows; only
// the DEPTH the dome writes into the test changes.
//
// `gl_Position.z = gl_Position.w` lands every one of the dome's fragments at
// ndc z = 1.0 — the far plane, exactly where a cleared depth buffer already is.
// With depthTest on and three's default LessEqual, the dome then passes only
// where nothing has been drawn, and is rejected before shading everywhere the
// ocean, the terrain, a hull or a rock already wrote depth.
//
// This is not the same as depth-testing the sphere as authored. The sphere has
// a 2800m radius and the ocean grid runs out to 3264m, so a depth-tested dome
// would sit IN FRONT of the last few hundred metres of sea and paint over it.
// Pinned to the far plane it can never be in front of anything.
const SKY_VERT = /* glsl */`
  varying vec3 v_dir;
  void main() {
    v_dir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w;
  }
`;

// Sky is authored in display-referred values, then shaped to linear at the end so the
// same shader looks identical through the post chain (OutputPass) and direct rendering
// (in-shader tonemapping/colorspace chunks) on 'low'.
const SKY_FRAG = /* glsl */`
  varying vec3 v_dir;
  uniform vec3 u_sunDir;
  uniform float u_stormIntensity;
  // ── RAIN OUT OF A BLUE SKY ─────────────────────────────────────────────────
  // u_stormIntensity is the storm's WEATHER level, and the squall reaches inboard
  // of the ring so drops fall ~150 m ahead of the wall. That approach runs at a
  // weather level near 0.34-0.48, and this shader's response to 0.34 is a faint
  // grey wash over open blue: a full downpour was falling through white cumulus,
  // orange dusk horizons and visible stars. The audit's most dream-logic frame.
  //
  // So the CLOUD DECK gets its own number, driven from the rain volume the client
  // is actually drawing (Game -> setOvercast). Any rain you can see closes the
  // deck overhead; the full storm slate is still reserved for the storm itself.
  uniform float u_overcast;
  uniform float u_underwaterIntensity;
  // Lightning: 0..1 strike envelope + the world direction toward the bolt, so
  // the cloud deck lights from inside and the flash has an azimuth.
  uniform float u_lightningFlash;
  uniform vec3 u_lightningDir;
  uniform float u_dayAmount;
  uniform float u_twilightAmount;
  uniform float u_nightAmount;
  uniform float u_time;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.11369, 0.13787));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  float fbm2(vec2 p) {
    return vnoise(p) * 0.6667 + vnoise(p * 2.13 + 19.7) * 0.3333;
  }

  void main() {
    vec3 d = normalize(v_dir);

    // Day, dusk, and readable night gradients blended by the client time cycle.
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 dayZenith = vec3(0.09, 0.30, 0.72);
    vec3 dayMid = vec3(0.42, 0.66, 0.92);
    vec3 dayHorizon = vec3(0.78, 0.90, 0.98);
    vec3 twilightZenith = vec3(0.10, 0.12, 0.44);
    vec3 twilightMid = vec3(0.44, 0.36, 0.72);
    vec3 twilightHorizon = vec3(1.00, 0.54, 0.28);
    vec3 nightZenith = vec3(0.06, 0.11, 0.25);
    vec3 nightMid = vec3(0.11, 0.19, 0.33);
    vec3 nightHorizon = vec3(0.22, 0.32, 0.45);

    // ── THE SEAM ARC ────────────────────────────────────────────────────────
    // These ramps used to be smoothsteps in h, and every one of them ENDED
    // inside the visible dome: the zenith blend finished at h = 0.74, about 29
    // degrees up. A smoothstep's far edge is where a gradient stops changing all
    // at once, and the eye reads that as a line — a clean arc sweeping across
    // nearly every frame in the game, loudest at dusk but never actually absent.
    // It survived a 5x finer dome, every post pass being switched off, and the
    // whole scene being hidden; it was never geometry or bloom, it was the ramp.
    //
    // Exponential ramps have no far edge. They approach the zenith colour
    // asymptotically and never arrive, so there is no elevation anywhere in the
    // sky at which the gradient changes character. Constants chosen to sit on
    // the old curve through the middle of the dome, so the sky still reads the
    // same — it just no longer has an edge in it.
    // The offsets are the old ramps' value AT THE WATERLINE, so the dome still
    // starts where it always did and still deepens overhead at the same rate;
    // only the top of the curve changes, from "arrives at 29 degrees" to "never
    // quite arrives". The horizon swatch is held to a tight rim at the waterline
    // (it contributed nothing above it before) where it doubles as the colour
    // the far sea dissolves into.
    float up = clamp(d.y, 0.0, 1.0);
    float rim = 1.0 - exp(-up * 26.0);
    vec3 daySky = mix(dayMid, dayZenith, 1.0 - 0.55 * exp(-up * 2.60));
    daySky = mix(dayHorizon, daySky, rim);
    vec3 twilightSky = mix(twilightMid, twilightZenith, 1.0 - 0.41 * exp(-up * 2.75));
    twilightSky = mix(twilightHorizon, twilightSky, rim);
    vec3 nightSky = mix(nightMid, nightZenith, 1.0 - 0.45 * exp(-up * 2.45));
    nightSky = mix(nightHorizon, nightSky, rim);

    // The weather the CLOUD DECK answers to: whichever is heavier, the storm
    // level or the rain that is actually falling. Rain 0.30 is a legible
    // downpour, so that is where the deck is fully closed.
    float oc = max(u_stormIntensity, smoothstep(0.03, 0.30, u_overcast));

    vec3 sky = daySky * u_dayAmount + twilightSky * u_twilightAmount + nightSky * u_nightAmount;
    float antiSun = pow(max(0.0, dot(d, normalize(vec3(-u_sunDir.x, 0.18, -u_sunDir.z)))), 2.2);
    sky = mix(sky, mix(vec3(0.28, 0.22, 0.62), vec3(0.08, 0.13, 0.24), u_nightAmount), antiSun * 0.18 * (1.0 - oc));

    // Storm layer: desaturate, then blend to a dark brooding overcast
    float grey = dot(sky, vec3(0.299, 0.587, 0.114));
    sky = mix(sky, vec3(grey), oc * 0.4);
    vec3 sZen = vec3(0.12, 0.13, 0.17);
    vec3 sMid = vec3(0.26, 0.28, 0.32);
    vec3 sHor = vec3(0.45, 0.46, 0.50);
    vec3 stormSky = mix(sHor, sMid, smoothstep(0.0, 0.32, h));
    stormSky = mix(stormSky, sZen, smoothstep(0.18, 0.78, h));
    // The slate itself is the STORM's; rain under a fair-weather sky gets most of
    // the way there so the light overhead matches the water coming out of it,
    // without repainting a clear afternoon the moment a squall clips the frame.
    sky = mix(sky, stormSky, max(u_stormIntensity, oc * 0.80));

    // Stylized drifting 2-octave fbm cloud layer
    float skyUp = smoothstep(0.015, 0.14, d.y);
    vec2 cuv = d.xz / (abs(d.y) * 0.85 + 0.22);
    vec2 drift = vec2(u_time * 0.010, u_time * 0.0042);
    float cf = fbm2(cuv * 1.15 + drift);
    float coverage = mix(0.42, 0.18, oc);
    float cloud = smoothstep(coverage, coverage + mix(0.28, 0.40, oc), cf) * skyUp;
    float cfLit = fbm2(cuv * 1.15 + drift + u_sunDir.xz * 0.16);
    float litEdge = clamp((cf - cfLit) * 2.6 + 0.55, 0.0, 1.0);
    vec3 cloudLit = vec3(1.00, 0.99, 0.96) * u_dayAmount + vec3(1.00, 0.62, 0.40) * u_twilightAmount + vec3(0.30, 0.35, 0.47) * u_nightAmount;
    vec3 cloudShade = vec3(0.62, 0.68, 0.78) * u_dayAmount + vec3(0.42, 0.33, 0.46) * u_twilightAmount + vec3(0.12, 0.15, 0.22) * u_nightAmount;
    cloudLit = mix(cloudLit, vec3(0.35, 0.37, 0.41), oc);
    cloudShade = mix(cloudShade, vec3(0.10, 0.11, 0.13), oc);
    float cloudAlpha = cloud * mix(0.85, 0.97, oc);
    sky = mix(sky, mix(cloudShade, cloudLit, litEdge), cloudAlpha);

    // ── Lightning illumination: the strike lights the CLOUD DECK from inside
    //    (bellies flare, clear sky only lifts) and is brightest toward the
    //    bolt's azimuth, so the flash has a direction you can read ──────────
    float boltLobe = 0.0;
    if (u_lightningFlash > 0.001) {
      float boltAz = dot(normalize(vec3(d.x, 0.0001, d.z)), u_lightningDir);
      boltLobe = (0.08 + 0.92 * pow(max(0.0, boltAz), 2.2))
               * (1.0 - smoothstep(0.05, 0.85, d.y) * 0.55);
      float boltGlow = u_lightningFlash * boltLobe;
      // Deliberately restrained: the CHANNEL has to stay the brightest thing on
      // screen, so the sky lifts and the cloud bellies flare, but nothing here
      // is allowed to blow the whole dome to flat white.
      sky += vec3(0.60, 0.70, 0.92) * boltGlow * (0.08 + cloudAlpha * 0.95);
      sky = mix(sky, vec3(0.74, 0.82, 0.99), boltGlow * cloudAlpha * 0.22);
    }

    // Storm scud: fast low dark wisps racing along the horizon band
    float scud = smoothstep(0.48, 0.92, fbm2(cuv * 2.4 + vec2(u_time * 0.055, u_time * 0.020) + 31.7));
    float scudBand = smoothstep(-0.02, 0.06, d.y) * (1.0 - smoothstep(0.16, 0.52, d.y));
    sky = mix(sky, vec3(0.055, 0.060, 0.075), scud * scudBand * oc * 0.85);

    // Sun disk + glow corona (heavily muted in storm)
    float sunDot  = dot(d, u_sunDir);
    float sunAbove = smoothstep(-0.04, 0.09, u_sunDir.y);
    float sunDisk = smoothstep(0.9994, 0.9999, sunDot);
    float corona  = pow(max(0.0, sunDot), 9.0);
    float scatter = pow(max(0.0, sunDot), 3.2);
    float sunVis = mix(1.0, 0.06, oc) * sunAbove;
    vec3 scatterTint = mix(vec3(1.0, 0.78, 0.35), vec3(1.0, 0.32, 0.22), u_twilightAmount);
    sky += scatterTint * scatter * 0.22 * (1.15 - h) * sunVis * (1.0 - cloudAlpha * 0.6);
    sky += vec3(0.62, 0.22, 0.72) * pow(max(0.0, sunDot), 1.8) * 0.08 * sunVis * u_twilightAmount;
    float moonDot = dot(d, -u_sunDir);
    float moonDisk = smoothstep(0.99972, 0.99994, moonDot) * u_nightAmount * (1.0 - oc * 0.7);

    // Hash-grid stars, fading in with night and hidden by clouds/storm
    float starField = 0.0;
    vec3 sp = d * 150.0;
    float sh = hash31(floor(sp));
    if (sh > 0.905) {
      vec3 jitter = fract(vec3(sh * 719.7, sh * 431.3, sh * 213.9)) - 0.5;
      float distToStar = length(fract(sp) - 0.5 - jitter * 0.55);
      float twinkle = 0.72 + 0.28 * sin(u_time * (1.2 + fract(sh * 57.0) * 2.4) + sh * 41.0);
      starField = smoothstep(0.30, 0.02, distToStar) * (0.3 + 0.7 * fract(sh * 97.0)) * twinkle;
    }
    float starVis = u_nightAmount * (1.0 - oc) * (1.0 - cloudAlpha) * smoothstep(0.02, 0.24, d.y);
    // The starfield is EMISSIVE and added in LINEAR, where the noon zenith sits
    // near 0.015 — so a starVis of two percent is not "almost off", it is a
    // bloomed white speck on a blue afternoon, which is what the audit found at
    // setDayNightOverride(854). Daylight takes the field to a HARD zero, and the
    // floor under it goes too: an asymptote is not the same thing as out.
    starVis *= 1.0 - smoothstep(0.08, 0.34, u_dayAmount);
    starVis = max(0.0, starVis - 0.02) * 1.0204;
    sky += vec3(0.62, 0.70, 0.86) * starField * starVis * 0.55;

    // Horizon haze band
    float haze = pow(1.0 - abs(d.y), 7.0) * 0.38 * mix(1.0, 0.35, oc);
    vec3 hazeColor = dayHorizon * u_dayAmount + twilightHorizon * u_twilightAmount + nightHorizon * u_nightAmount;
    vec3 hazeMix = mix(hazeColor, vec3(0.50, 0.53, 0.57), oc);
    sky = mix(sky, hazeMix, haze);

    // ── Below the eye-level horizon the dome IS the far sea ──────────────
    // The ocean grid stops at 3264 m. Stand on a deck and that rim is under the
    // horizon line and invisible; climb a volcano or a mast and it lifts into
    // frame as a hard curved edge, pale sea-haze on one side and mid-sky blue on
    // the other — the "horizon band" at altitude. The sea dissolves into
    // u_horizonColor by 3 km (OceanRenderer's horizonAmt) and hazeColor here is
    // authored from the SAME horizon swatches, so painting everything below the
    // horizon with it makes the rim land on its own colour and disappear. The
    // ramp reaches full by d.y = -0.13, which covers the rim from any altitude
    // up to ~430 m; under the ocean's own silhouette it is never seen at all.
    sky = mix(sky, hazeMix, smoothstep(0.035, -0.13, d.y));

    vec3 waterBelow = mix(vec3(0.00, 0.04, 0.08), vec3(0.02, 0.18, 0.27), smoothstep(-0.7, 0.2, d.y));
    vec3 waterGlow = vec3(0.08, 0.42, 0.52) * pow(max(0.0, d.y), 2.0);
    sky = mix(sky, waterBelow + waterGlow, u_underwaterIntensity);

    // A clear sky is the flattest gradient on screen — a whole quadrant can span
    // three or four 8-bit codes — so it is the one surface where quantisation
    // contours show. One LSB of triangular-PDF noise, added in the authored
    // domain, turns those contours into grain nobody can see.
    float d1 = hash21(gl_FragCoord.xy);
    float d2 = hash21(gl_FragCoord.xy + 41.7);
    sky += (d1 + d2 - 1.0) * (1.6 / 255.0);

    // Display-authored -> linear, shaped so ACES + sRGB output lands near the authored values
    sky = max(sky, vec3(0.0));
    sky = sky * sky * sky * 0.55 + sky * 0.06;

    // Emissive terms added in linear so bloom picks them up
    float notUnder = 1.0 - u_underwaterIntensity;
    float cloudOcclusion = 1.0 - cloudAlpha * 0.85;
    sky += vec3(1.0, 0.86, 0.42) * (sunDisk * 3.2 + corona * 0.30) * sunVis * cloudOcclusion * notUnder;
    sky += vec3(0.55, 0.68, 1.00) * moonDisk * 1.5 * cloudOcclusion * notUnder;
    sky += vec3(0.80, 0.88, 1.10) * starField * starVis * 0.9 * notUnder;
    // Emissive in linear so bloom blooms off the lit cloud belly.
    sky += vec3(0.55, 0.66, 0.95) * u_lightningFlash * boltLobe * 0.3 * notUnder;

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface Atmosphere {
  /** The light that is actually SHINING: the sun by day, the anti-sun (moon)
   *  after dusk — the same vector the scene's directional light uses. */
  sunDir: THREE.Vector3;
  /** The astronomical sun, below the horizon at night. Only the warm sunset
   *  terms (sunLow / sunPath) may key off this; everything else wants sunDir. */
  sunDirTrue: THREE.Vector3;
  fogColor: THREE.Color;
  horizonColor: THREE.Color;
  /** Scene key light, calibrated so NOON reproduces the ocean's old 0.62. */
  keyColor: THREE.Color;
  /** Ambient + half the hemisphere, calibrated so NOON reproduces 0.48. */
  ambientColor: THREE.Color;
  storminess: number;
  nightFactor: number;
  twilightFactor: number;
  /** 1 once the sun is down and the key light is the moon. */
  moonness: number;
  /** THE SCENE'S OWN FogExp2 density. Land and sea cannot agree on fog while
   *  each owns its own curve: three's is Gaussian, the ocean's was exponential,
   *  and at 800 m that is 55% against 22% — the "dark island pasted on a bright
   *  sea" read, which no amount of re-tuning two different families can close. */
  fogDensity: number;
}

// ── OCEAN LIGHT CALIBRATION ────────────────────────────────────────────────
// The ocean's whole light model was `base *= 0.48 + diff * 0.62` — two numbers
// hand-tuned for noon, at every hour of the day, which is why the night sea had
// to be dimmed by a separate magic 0.42 and why every re-tune of the inversion
// came undone the next time a light changed. The sea now reads the scene's own
// lights; these constants exist only to make NOON land exactly where it did, so
// the change is a change to the other twenty-three hours.
const OCEAN_AMBIENT_NOON = 0.48;
const OCEAN_KEY_NOON = 0.62;
/** getCycleSunIntensity() at dayAmount 1. */
const OCEAN_KEY_NOON_INTENSITY = 2.65;
/** How much of each light's HUE the water takes. Full strength would swing the
 *  noon sea toward the hemisphere's blue by a visible amount for no defect;
 *  the magnitude is what carries the day/night truth, the hue is seasoning. */
const OCEAN_LIGHT_TINT = 0.45;
/** Rec.709 luminance of a linear colour (three's Color has no getLuminance). */
const colorLuma = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

// Camera-following shadow frustum: an ortho box snapped to shadow texels. Sized
// to swallow a whole large island (radius up to ~96m) so its cast/self shadows
// never clip to a hard rectangular seam on the terrain you're standing near.
const SHADOW_HALF_EXTENT = 155;
const SHADOW_LIGHT_DISTANCE = 210;
const SHADOW_UP = new THREE.Vector3(0, 1, 0);
const SHADOW_ORIGIN = new THREE.Vector3(0, 0, 0);

export class Renderer {
  public renderer!: THREE.WebGLRenderer;
  public scene!: THREE.Scene;
  public camera!: THREE.PerspectiveCamera;

  private sun!: THREE.DirectionalLight;
  private ambientLight!: THREE.AmbientLight;
  private hemisphereLight!: THREE.HemisphereLight;
  private horizonFill!: THREE.DirectionalLight;
  private skyMesh!: THREE.Mesh;
  private skyMaterial!: THREE.ShaderMaterial;
  private sunDisc!: THREE.Mesh;
  private sunGlow!: THREE.Mesh;
  private readonly sunDir = new THREE.Vector3(0.2, 0.92, -0.34).normalize();
  private readonly activeLightDir = new THREE.Vector3();
  /** smoothstep(-0.06, 0.12, sunDir.y) from updateDayNight: 0 once the key light
   *  is the moon. getAtmosphere hands its complement to the ocean as moonness. */
  private sunAboveAmount = 1;
  // Distance fog is deliberately DARKER than the sky it sits under. A fog tint
  // that matched the horizon washed every island to a white ghost by ~500m and
  // killed navigate-by-silhouette: only Old Maw (dark volcanic rock) survived.
  // Keeping the haze a few stops under the sky keeps mountain profiles readable
  // out to 800m while still reading as atmosphere.
  private readonly fogDayColor = new THREE.Color(0x7ba3bd);
  private readonly fogTwilightColor = new THREE.Color(0x94737a);
  private readonly fogNightColor = new THREE.Color(0x23374e);
  private readonly fogStormColor = new THREE.Color(0x4a5764);
  private readonly underwaterFillColor = new THREE.Color(0x63c6d6);
  private readonly underwaterFloorColor = new THREE.Color(0x2f7f8c);
  private readonly fogUnderwaterNearColor = new THREE.Color(0x1a6f86);
  private readonly fogUnderwaterDeepColor = new THREE.Color(0x0a3a4a); // murky teal, not a black void
  private readonly tempFogColor = new THREE.Color();
  private readonly tempUnderwaterFogColor = new THREE.Color();
  private readonly sunDayColor = new THREE.Color(0xfff0d8);
  private readonly sunTwilightColor = new THREE.Color(0xffbd6d);
  private readonly moonColor = new THREE.Color(0x8aa6ff);
  private readonly ambientDayColor = new THREE.Color(0x8a9aad);
  private readonly ambientTwilightColor = new THREE.Color(0x6270aa);
  private readonly ambientNightColor = new THREE.Color(0x526f95);
  private readonly hemiSkyDayColor = new THREE.Color(0x88bbdd);
  private readonly hemiSkyTwilightColor = new THREE.Color(0x8891df);
  private readonly hemiSkyNightColor = new THREE.Color(0x536fa8);
  private readonly hemiGroundDayColor = new THREE.Color(0xc4a86a);
  private readonly hemiGroundTwilightColor = new THREE.Color(0xd99a4d);
  private readonly hemiGroundNightColor = new THREE.Color(0x4e5a6c);
  private readonly horizonDayColor = new THREE.Color(0xffddb0);
  private readonly horizonTwilightColor = new THREE.Color(0xff7f8e);
  private readonly horizonNightColor = new THREE.Color(0x334c7a);
  private readonly skyHorizonDayColor = new THREE.Color(0xc7e6fa);
  private readonly skyHorizonTwilightColor = new THREE.Color(0xff8a47);
  private readonly skyHorizonNightColor = new THREE.Color(0x38516f);
  private readonly skyHorizonStormColor = new THREE.Color(0x73767f);
  // ── Storm light COLOURS ───────────────────────────────────────────────────
  // Dimming alone was never enough. Under a black squall the sun kept its warm
  // 0xfff0d8, the hemisphere kept a summer-blue sky over amber sand bounce, and
  // the islands stayed sunny green with a bright teal lagoon while the sky above
  // them went to slate — the single loudest "the weather is fake" tell in the
  // game. A storm removes the SPECTRUM as well as the level: the key goes flat
  // grey-blue (cloud light has no sun in it), the sky term goes to wet slate and
  // the bounce term to wet sand, and everything lit by them desaturates
  // together. Intensity ramps stay exactly where they were tuned.
  private readonly sunStormColor = new THREE.Color(0xa8b0b8);
  private readonly ambientStormColor = new THREE.Color(0x767f89);
  private readonly hemiSkyStormColor = new THREE.Color(0x6f7783);
  private readonly hemiGroundStormColor = new THREE.Color(0x6a6660);
  private readonly horizonFillStormColor = new THREE.Color(0x8f959c);
  private dayAmount = 1;
  private twilightAmount = 0;
  private nightAmount = 0;
  private stormLevel = 0;
  private readonly qualityVerdict: QualityVerdict = decideRenderQuality();
  private readonly quality = this.qualityVerdict.quality;
  private readonly minPixelRatio = this.quality === 'low' ? 0.44 : this.quality === 'balanced' ? 0.58 : 0.8;
  private readonly maxPixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO[this.quality]);
  private currentPixelRatio = 1;
  /**
   * THE SHADOW MAP WAS THIRTY-TWO TIMES THE SIZE OF THE SCREEN.
   *
   * 4096² over the 310 m ortho box (see SHADOW_HALF_EXTENT) is 16,777,216
   * texels a frame at 7.6 cm each — 32.4× the 960×540 framebuffer's pixel
   * count, 112.0 MB of the 160.5 MB of render-target residency, and a knob the
   * resolution ladder cannot touch a single texel of. It was the largest single
   * fill item in the game by an order of magnitude.
   *
   * WHY 15 CM PER TEXEL COSTS NOTHING TO LOOK AT: `shadow.normalBias` is 1.0 m
   * at `high` and 1.8 m at `balanced`, in WORLD units. At 4096 that bias was
   * already 13 texels wide — every contact edge the extra resolution could have
   * resolved was being pushed a metre off the caster before it was sampled, and
   * then softened again by PCFSoft. The map was paying for precision the bias
   * had already spent.
   *
   * 2048² is 4.19 M texels and 28.0 MB; `balanced` at 1536² is 2.36 M and
   * 15.75 MB. The governor's ladder steps down from whichever of those the tier
   * opened with.
   */
  private readonly baseShadowMapSize = this.quality === 'high' ? 2048 : 1536;
  private postFx: PostFx | null = null;
  private readonly shadowFocus = new THREE.Vector3();
  private readonly shadowBasis = new THREE.Matrix4();
  private readonly shadowBasisInv = new THREE.Matrix4();
  private readonly cameraForward = new THREE.Vector3();
  private readonly atmosphere: Atmosphere = {
    sunDir: new THREE.Vector3(0.2, 0.92, -0.34).normalize(),
    sunDirTrue: new THREE.Vector3(0.2, 0.92, -0.34).normalize(),
    fogColor: new THREE.Color(0x9bbfd4),
    horizonColor: new THREE.Color(0xc7e6fa),
    keyColor: new THREE.Color(OCEAN_KEY_NOON, OCEAN_KEY_NOON, OCEAN_KEY_NOON),
    ambientColor: new THREE.Color(OCEAN_AMBIENT_NOON, OCEAN_AMBIENT_NOON, OCEAN_AMBIENT_NOON),
    storminess: 0,
    nightFactor: 0,
    twilightFactor: 0,
    moonness: 0,
    fogDensity: 0.00112,
  };
  /** 0..1 falling-rain density from EnvironmentFx. Rain is not just streaks: a
   *  downpour thickens the air, so it adds fog density and pulls the fog toward
   *  a wet slate grey on top of whatever the storm/day cycle already asked for. */
  private rainMist = 0;
  private readonly fogRainColor = new THREE.Color(0x54606b);
  private perfTimer = 0;
  private perfFrameCount = 0;
  private perfFrameTime = 0;
  /**
   * THE GOVERNOR. One controller, one notion of "too slow", and it can say what
   * it is running — see FrameGovernor.ts for the argument and the lever order.
   * It replaced a resolution scaler chasing 47fps off a one-second average and
   * a separate two-rung "distress ladder" firing after 6.9s under 28fps, which
   * measured different things, disagreed, and between them could take the
   * picture apart in a way nothing in the client could report.
   */
  private readonly governor = new FrameGovernor({}, Renderer.OPENING_SCALAR);
  private readonly governorCaps: LeverCaps = {
    tier: this.quality,
    maxPixelRatio: this.maxPixelRatio,
    minPixelRatio: this.minPixelRatio,
    baseShadowMapSize: this.quality === 'low' ? 0 : this.baseShadowMapSize,
  };
  /**
   * Where the session OPENS on the ladder, before a single frame has been
   * measured.
   *
   * Not 1. On a dPR-2 panel the ceiling is four times the fragments of 1.0, and
   * opening there means handing an unknown machine everything the tier allows
   * and then walking it back down while it stutters — which is what the old
   * scaler's hard-coded `min(max, 1.2)` was reaching for, badly, because it
   * only ever moved the resolution. At 0.85 the levers that are spent are the
   * ones nobody can see (§ FrameGovernor.resolveLevers: shadow map and far
   * dressing at `high`; a 4% resolution trim at `low`), and four seconds of
   * frames inside budget hands all of it straight back.
   */
  private static readonly OPENING_SCALAR = 0.85;
  private levers: GovernorLevers = resolveLevers(Renderer.OPENING_SCALAR, this.governorCaps);
  private appliedScalar = Renderer.OPENING_SCALAR;
  private appliedShadowExtent = SHADOW_HALF_EXTENT;
  private lastStormWeather = -1;

  init() {
    this.governor.setEnabled(governorEnabledFor(this.qualityVerdict.reason));
    // Re-derive before anything is built: a DISABLED governor hands back full
    // tier quality rather than the opening scalar, and the shadow map size and
    // the opening pixel ratio are both read out of `levers` below.
    this.appliedScalar = this.governor.getScalar();
    this.levers = resolveLevers(this.appliedScalar, this.governorCaps);
    this.scene = new THREE.Scene();
    // The scene root never moves. That matters for more than tidiness: three
    // re-composes a node's local matrix every frame when matrixAutoUpdate is
    // on, and a re-composed matrix FORCES the world-matrix walk through every
    // descendant — which would defeat every freezeStaticSubtree() below it.
    freezeStaticParent(this.scene);
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(this.fogDayColor.getHex(), 0.0015);
    initLightBudget(this.scene, this.quality);

    // NEAR 0.1, NOT 0.05, AND THE FAR:NEAR RATIO IS THE WHOLE POINT.
    //
    // A fixed-point depth buffer spends its levels on the near end: the metres
    // per level at a distance z go as z^2 / (near * 2^24), so at 0.05 a pair of
    // coplanar surfaces 300 m away was being resolved at ONE LEVEL PER 10.7 cm
    // and anything closer together than that tied. Measured, at the dock vista
    // on the pinned map: 121-137 pixels standing on a depth-buffer tie. At 0.3
    // the same two stands read 34-35 and 21-33 (see scripts/test-z-fighting.mjs
    // for what a tie is and why the count is exact).
    //
    // What stopped it being raised was never the world — the closest surface
    // over 17 close-quarters stands, crouched and inside a cave, is 0.30 m. It
    // was the first-person viewmodel, whose cutlass reaches 0.122 m from the eye
    // mid-swing. `depthTest: false` exempted it from the depth TEST and not from
    // near-plane CLIPPING; applyViewmodelMaterialSettings now pins its clip-space
    // z instead, so no weapon, hand or tool can be cut by either plane.
    //
    // AND THEN 0.2 WAS MEASURED AND REJECTED, by something neither the survey nor
    // the viewmodel argument had in it: THE LOCAL PLAYER'S OWN THIRD-PERSON RIG.
    // At rest the nearest thing in frame is 0.38 m, but in the cutlass block pose
    // the rig's forearm crosses the eye at 0.1226 m — world geometry, not
    // camera-attached, so the viewmodel exemption does not cover it, and 0.2 cut
    // 32,877 pixels out of it. 0.1 is the largest near plane that clears every
    // surface measured anywhere: the rig at 0.1226 m, the cutlass viewmodel at
    // 0.1214 m, and the closest world surface over 17 close-quarters stands
    // (crouched, and under a cave roof) at 0.3029 m.
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 3000,
    );
    this.camera.position.set(0, 12, -20);
    // Required so first-person viewmodels parented to the camera are included in scene traversal.
    this.scene.add(this.camera);

    // AA comes from the post chain (MSAA target or FXAA); low renders direct without AA.
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setOpaqueSort(frontToBack);
    // Open where the governor opens (see OPENING_SCALAR), not at the ceiling.
    this.applyPixelRatio(this.levers.pixelRatio, true);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // THE DEFAULT COSTS SECONDS, NOT MICROSECONDS. With this on, three's
    // `onFirstUse` reads two shader info logs, a program info log and the
    // LINK_STATUS the first time each program is used — four synchronous calls
    // that each JOIN a link ANGLE is still doing on its own threads. That join
    // is where a cold start lost 2.4s at a time. ProgramWarmer turns the flag
    // back on around its own budgeted first-use call, so every program it warms
    // is still fully checked; `?shadererrors` re-arms it globally for shader work.
    this.renderer.debug.checkShaderErrors = shaderErrorsForced();
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.installShadowPassGate();
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild);

    // ── Sky dome ────────────────────────────────────────────────
    // TESSELLATION IS NOT COSMETIC HERE. v_dir is the interpolated object-space
    // position, re-normalised per fragment: continuous across a shared edge, but
    // its DERIVATIVE is not — normalize(lerp(a,b)) is not slerp(a,b), so every
    // latitude ring of the sphere is a C1 crease in d.y. The gradient ramps are
    // smoothsteps of d.y, and the eye reads a crease in a smooth ramp as a hard
    // line: at 20x10 the dome drew a visible arc across nearly every frame (a
    // ring ~18 degrees up), long blamed on dusk because that is where it was
    // loudest. At 96x48 the rings are 3.75 degrees apart, the angular error
    // inside a quad drops by ~23x, and the crease falls under a quantisation
    // step. It costs ~9k triangles on a dome drawn once, depth-test off.
    const skySegments = SKY_SEGMENTS[this.quality];
    const skyGeo = new THREE.SphereGeometry(2800, skySegments.width, skySegments.height);
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        u_sunDir: { value: this.sunDir.clone() },
        u_stormIntensity: { value: 0 },
        u_overcast: { value: 0 },
        u_underwaterIntensity: { value: 0 },
        u_lightningFlash: { value: 0 },
        u_lightningDir: { value: new THREE.Vector3(0, 0, 1) },
        u_dayAmount: { value: 1 },
        u_twilightAmount: { value: 0 },
        u_nightAmount: { value: 0 },
        u_time: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      // See SKY_VERT. The dome used to be `depthTest: false, renderOrder: -1`,
      // i.e. the first thing drawn and the one surface in the game that nothing
      // could reject: it shaded EXACTLY 1.000 layers over 100.0% of the
      // framebuffer in all nine measured scenes at both tiers, and 52-63% of
      // that was then painted over by the ocean, the terrain or a hull. That is
      // 267k-328k fragments of a 138-line, ~470-op procedural shader computed
      // and thrown away in every frame at every tier — the largest single item
      // in the fill budget after the shadow map, and the cheapest to stop.
      depthTest: true,
      // Stated rather than inherited: the far-plane trick is only correct under
      // a <= comparison. Under GL_LESS every dome fragment would fail against
      // the cleared 1.0 and the sky would be black.
      depthFunc: THREE.LessEqualDepth,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, this.skyMaterial);
    // Drawn after the WORLD's opaques rather than before them, so the depth the
    // ocean, the terrain and the hulls wrote is already there to reject it.
    //
    // 100, not 1000, and the gap is load-bearing. The world draws at 0-20; the
    // FIRST-PERSON VIEWMODEL draws at 996-1000 with `depthTest: false,
    // depthWrite: false` on purpose (see applyViewmodelMaterialSettings — a
    // viewmodel does not participate in world depth), and those materials are
    // opaque, so they share this list. A sky sorted past them would be rejected
    // by nothing and would paint over the player's own hands.
    //
    // Transparents are unaffected either way: three renders the whole opaque
    // list before the whole transparent one, so rain, spray, the storm front
    // and the sun corona still blend over sky exactly as before.
    this.skyMesh.renderOrder = 100;
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    // ── Sun ─────────────────────────────────────────────────────
    const sunWorldDir = this.sunDir.clone().multiplyScalar(400);
    // depthTest STAYS ON for both. With it off, the twilight glow corona — a
    // 124m additive disc parked 2km out, tinted hot pink by the dusk horizon
    // colour — painted straight over whatever island stood between you and the
    // sunset: a huge translucent pink plate hovering over the dock island.
    // Depth-tested, the sun sets behind the land like it should.
    const sunDiscMat = new THREE.MeshBasicMaterial({
      color: 0xffd36a,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const sunGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff6f45,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      depthTest: true,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.sunGlow = new THREE.Mesh(new THREE.CircleGeometry(96, 40), sunGlowMat);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(28, 40), sunDiscMat);
    this.sunGlow.renderOrder = -0.5;
    this.sunDisc.renderOrder = -0.45;
    this.sunGlow.frustumCulled = false;
    this.sunDisc.frustumCulled = false;
    this.scene.add(this.sunGlow);
    this.scene.add(this.sunDisc);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.75);
    this.sun.position.copy(sunWorldDir);
    this.sun.castShadow = this.quality !== 'low';
    // Larger frustum (see SHADOW_HALF_EXTENT) needs more texels to stay crisp —
    // and the governor owns how many of them this session opens with.
    const shadowMapSize = this.levers.shadowMapSize || this.baseShadowMapSize;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.camera.near = 30;
    this.sun.shadow.camera.far = SHADOW_LIGHT_DISTANCE + 230;
    this.sun.shadow.camera.left   = -SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.right  =  SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.top    =  SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.bottom = -SHADOW_HALF_EXTENT;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = this.quality === 'high' ? 1.0 : 1.8;
    this.scene.add(this.sun);
    // Target must be in the graph so the follow-camera shadow frustum updates.
    this.scene.add(this.sun.target);

    // Ambient sky light (blue-ish to simulate skylight scatter)
    this.ambientLight = new THREE.AmbientLight(0x7090b8, 0.68);
    this.scene.add(this.ambientLight);

    // Hemisphere: violet sky scatter → amber sand bounce.
    this.hemisphereLight = new THREE.HemisphereLight(0x88bbdd, 0xc4a86a, 0.78);
    this.scene.add(this.hemisphereLight);

    // Warm horizon fill on opposite side to sun
    this.horizonFill = new THREE.DirectionalLight(0xffddb0, 0.3);
    this.horizonFill.position.set(-300, 30, -450);
    this.scene.add(this.horizonFill);

    if (this.quality !== 'low') {
      try {
        this.postFx = new PostFx(this.renderer, this.scene, this.camera, this.quality);
        this.postFx.setSize(window.innerWidth, window.innerHeight);
        this.postFx.setPixelRatio(this.currentPixelRatio);
      } catch (error) {
        console.warn('PostFx unavailable, falling back to direct rendering', error);
        this.postFx = null;
      }
    }

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      // The one caller that must reallocate at an UNCHANGED ratio: the drawing
      // buffer has to follow the window even when the ratio has not moved.
      this.applyPixelRatio(this.currentPixelRatio, true);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.postFx?.setSize(window.innerWidth, window.innerHeight);
    });
  }

  getQuality(): RenderQuality {
    return this.quality;
  }

  /** The tier AND the signal that chose it, so the settings panel can say
   *  "Auto (low — Apple M2, Air class)" instead of leaving the player to guess
   *  why their machine looks the way it does. */
  getQualityVerdict(): QualityVerdict {
    return this.qualityVerdict;
  }

  /** The TIER's effect budget. Build-time only — IslandBuilder reads this to
   *  decide how much geometry to author, and that answer must not change while
   *  a session is running or the same island would be two different islands. */
  getEffectScale(): number {
    return this.quality === 'low' ? 0.48 : this.quality === 'balanced' ? 0.8 : 1;
  }

  /** The tier's effect budget as the GOVERNOR currently allows it. For the
   *  per-frame spawners (rain splashes, combat FX) only. Halved at the very
   *  bottom of the ladder and never further: rain you cannot see falling is a
   *  weather bug, not a saving. */
  getRuntimeEffectScale(): number {
    return this.getEffectScale() * this.levers.particleScale;
  }

  /** The same lever as an EDGE-LENGTH scale for the systems whose cost is the
   *  area of a quad rather than the number of them — the combat sprite pools.
   *  `particleScale` is a budget in fragments and fill goes as the square, so
   *  what a quad's size gets is its root. 1.0 → 0.707 across the whole ladder. */
  getParticleFillScale(): number {
    return Math.sqrt(this.levers.particleScale);
  }

  areShadowsEnabled(): boolean {
    return this.renderer?.shadowMap.enabled ?? false;
  }

  /**
   * The camera three's shadow pass culls casters against — or null when there
   * is no shadow pass at all.
   *
   * Exposed for ONE caller: the group-level island cull, which turns a whole
   * island group off when it cannot be in frame. `visible === false` removes a
   * subtree from the shadow walk exactly as it removes it from the colour walk,
   * so the only way that cull can be proved not to drop a shadow is to ask the
   * same question the shadow pass asks. Anything outside this frustum was
   * already casting nothing.
   *
   * The matrices are one frame old — they are written during render(), after
   * the game loop has done its culling — so the caller pads its test. Over one
   * frame the focus moves as far as the camera did, which is metres.
   */
  getShadowCullCamera(): THREE.Camera | null {
    if (!this.areShadowsEnabled() || !this.sun?.castShadow) return null;
    return this.sun.shadow.camera;
  }

  /**
   * One frame's worth of governing. Called from the game loop with the frame's
   * RAW wall-clock length in MILLISECONDS, before render().
   *
   * RAW, not the simulation dt. `Game.frame` clamps dt to 50 ms so a stall
   * cannot integrate a ship through a hull in one step — and for two rounds
   * that clamped number was what arrived here, so a 3000 ms hitch and a 50 ms
   * frame were the same reading to the controller that exists to react to
   * hitches, and to the tier audition that decides what this machine gets NEXT
   * launch. Both of those are measurements of the machine and both get real
   * time; the clamp stays where it belongs, on the integrator.
   *
   * Everything expensive is behind a change test. `applyLevers` writes nothing
   * that has not moved, which matters more than it sounds: setPixelRatio is a
   * swapchain reallocation and re-writing it every frame was 19.5 seconds of
   * WebGLRenderer.setSize in a 180-second capture in which no window was ever
   * resized (§9 lever 7).
   */
  updatePerformance(rawFrameMs: number) {
    const rawSeconds = rawFrameMs / 1000;
    this.perfTimer += rawSeconds;
    this.perfFrameTime += rawSeconds;
    this.perfFrameCount++;

    this.governor.pushFrame(rawFrameMs);
    const scalar = this.governor.update(performance.now());
    setFrameBudgetScale(this.governor.getStreamingScale());
    // The scalar is unchanged on the overwhelming majority of frames, and
    // `resolveLevers` allocates. Sixty objects a second for a value that moves
    // a few times a minute is exactly the per-frame garbage §6.3 measured at
    // 207-233 KB/s; the guard below is not an optimisation, it is not doing
    // work that has no result.
    if (scalar !== this.appliedScalar) {
      this.appliedScalar = scalar;
      this.applyLevers(resolveLevers(scalar, this.governorCaps));
    }

    // The between-sessions verdict still runs on the same one-second cadence it
    // always did — it is answering a different question (is this the right TIER
    // for this machine next launch) and it must not be confused by the fact
    // that the governor has already made this session survivable.
    if (this.perfTimer < 1.15) return;
    const avgFps = this.perfFrameCount / Math.max(0.001, this.perfFrameTime);
    this.perfTimer = 0;
    this.perfFrameTime = 0;
    this.perfFrameCount = 0;
    this.auditionTier(avgFps);
  }

  /** The world is still arriving (or a ceremony owns the screen): sample
   *  nothing. A frame spent building an island measures the build. */
  setGovernorSuspended(suspended: boolean): void {
    this.governor.setSuspended(suspended);
  }

  /** A frame the caller can name as a one-off — a match start, a respawn.
   *  Cheaper and more honest than guessing which long frames were real. */
  markFrameOneOff(): void {
    this.governor.markOneOff();
  }

  /** What the settings panel prints, and what the browser gate reads. */
  getGovernorStatus(): {
    enabled: boolean;
    mode: GovernorMode;
    scalar: number;
    targetFps: number;
    /** Frames in the live window. A median read off three samples is not a
     *  reading, and the gate that grades this window has to know when it is
     *  looking at one — every step clears the window. */
    samples: number;
    medianMs: number;
    p95Ms: number;
    pixelRatio: number;
    shadowMapSize: number;
    label: string;
  } {
    const stats = this.governor.getStats();
    return {
      enabled: this.governor.isEnabled(),
      mode: this.governor.getMode(),
      scalar: this.governor.getScalar(),
      targetFps: this.governor.getTargetFps(),
      samples: stats.samples,
      medianMs: stats.medianMs,
      p95Ms: stats.p95Ms,
      pixelRatio: this.currentPixelRatio,
      shadowMapSize: this.sun?.castShadow ? this.sun.shadow.mapSize.x : 0,
      label: describeGovernor(
        this.quality,
        this.qualityVerdict.reason === 'player' || this.qualityVerdict.reason === 'url',
        this.governor.getMode(),
        { ...this.levers, pixelRatio: this.currentPixelRatio },
      ),
    };
  }

  /** The shared streaming signal as it stands this frame — 1 means "no
   *  throttle". Diagnostics and the browser gate; the systems that spend it
   *  read it through FrameBudget.budgeted(). */
  getFrameBudgetScale(): number {
    return frameBudgetScale();
  }

  /** The levers as they stand, for the systems the renderer does not own —
   *  Game's LOD radii, the instance-density bias, the particle budget. */
  getFrameLevers(): GovernorLevers {
    return this.levers;
  }

  private applyLevers(next: GovernorLevers) {
    const prev = this.levers;
    this.levers = next;
    if (next.pixelRatio !== prev.pixelRatio) this.applyPixelRatio(next.pixelRatio);
    if (next.shadowMapSize !== prev.shadowMapSize) this.applyShadowMapSize(next.shadowMapSize);
    // shadowExtentScale is read straight out of `levers` by updateShadowFrustum
    // — an ortho box is three numbers on a matrix, not an allocation, so there
    // is nothing here to gate.
  }

  /**
   * THE STARTUP MICRO-BENCHMARK, run on real frames instead of a synthetic one.
   *
   * Auto-detection's good signal is the GPU's own name, and a browser that masks
   * WEBGL_debug_renderer_info leaves it with a core count — the one number that
   * cannot tell a fanless Air from a desktop. So the client also listens to the
   * frames it is actually producing: skip the first stretch (the world is still
   * streaming in and every machine looks bad), then judge a few seconds of
   * settled play. A machine that averages below AUDITION_FPS across that window
   * is not having a rough moment, it is on the wrong tier.
   *
   * The verdict is written for the NEXT launch rather than applied now on
   * purpose. The tier decides the shadow-map size, the sky dome's segment count
   * and the material set every island was built with; changing it mid-session
   * would re-link programs and rebuild geometry at exactly the moment the
   * machine has proven it has nothing to spare. The runtime distress ladder
   * already covers right now, and it is what carries this session.
   *
   * Never runs under an explicit ?quality= — every probe and suite in this repo
   * pins the tier, and an audition that wrote a floor from a SwiftShader run
   * would silently re-tier every measurement that followed it.
   */
  private auditionTier(avgFps: number) {
    if (this.auditionDone) return;
    if (this.qualityVerdict.reason === 'url' || this.qualityVerdict.reason === 'player') {
      this.auditionDone = true;
      return;
    }
    this.auditionElapsed += 1.15;
    if (this.auditionElapsed < Renderer.AUDITION_SKIP_SECONDS) return;
    this.auditionFpsSum += avgFps;
    this.auditionSamples += 1;
    if (this.auditionElapsed < Renderer.AUDITION_SKIP_SECONDS + Renderer.AUDITION_WINDOW_SECONDS) return;

    this.auditionDone = true;
    const mean = this.auditionFpsSum / Math.max(1, this.auditionSamples);
    if (mean >= Renderer.AUDITION_FPS) return;
    const below = tierBelow(this.quality);
    if (!below) return;
    saveAutoTierCeiling(below);
    console.info(
      `[quality] audition: ${mean.toFixed(1)}fps on '${this.quality}' — next launch opens on '${below}'. `
      + 'Override in Settings → Graphics.',
    );
  }

  /** Seconds of play ignored before the audition starts counting — the world is
   *  still streaming in and every machine looks bad through it. */
  private static readonly AUDITION_SKIP_SECONDS = 6;
  /** …and how long it then listens. Roughly the "3s micro-benchmark" idea, but
   *  spent on frames the player was going to render anyway. */
  private static readonly AUDITION_WINDOW_SECONDS = 4.6;
  /** Below this mean, over that window, the tier is simply wrong. Well under the
   *  47fps the resolution scaler chases: this must not fire on a machine that is
   *  merely being asked to turn its resolution down. */
  private static readonly AUDITION_FPS = 34;
  private auditionElapsed = 0;
  private auditionFpsSum = 0;
  private auditionSamples = 0;
  private auditionDone = false;

  // ── THE SHADOW PASS THAT DRAWS NOTHING ─────────────────────────────────────
  // The ortho box is 310 m of sea level around a point ahead of the camera, and
  // out on open water it is EMPTY: the phase-1 model measured 0 caster draws at
  // both `open-sea` and `storm-sea` — and the map was cleared, in full, every
  // frame anyway. At `high` that is 4.19 M texels of clear (16.78 M before the
  // size cut above) bought with nothing in them.
  //
  // `autoUpdate` and `needsUpdate` are the only two shadow knobs that are NOT
  // part of a material's program cache key. `shadowMap.enabled` is
  // (`WebGLPrograms.getParameters` folds it in), which is why the pass is gated
  // here rather than switched off: switching it off would re-link every
  // material in the scene, and shader links are the hitch class this whole
  // campaign exists to remove.
  //
  // Why skipping is CORRECT and not merely cheap: a pass that drew zero casters
  // leaves the map at its clear value, "nothing is nearer than the far plane",
  // which every shadow lookup reads as lit no matter where the light matrix has
  // moved since. A stale EMPTY map is not stale. The moment one caster draws,
  // the gate re-arms and the pass runs every frame again.
  //
  // The re-check is what bounds the mistake. After an empty pass the gate skips
  // at most SHADOW_RECHECK_FRAMES frames and then pays for one, so a caster
  // entering the box shows up within ~0.17 s at 60 fps — an island 150 m out,
  // at the far edge of a box that is centred 108 m ahead of the camera.
  //
  // THE DECISION LIVES INSIDE THE WRAPPER, not in this class's `render()`. It
  // was in `render()` first, and that is wrong twice over: three's shadow pass
  // is reached by anything that calls `renderer.render`, including the cost
  // model's own pass-split probe, which renders the scene directly — so the
  // probe would have found `needsUpdate` false from the last real frame, taken
  // a shadow-free render, and reported "0 caster draws" for every scene in the
  // game. A gate that only works when one particular caller remembers to arm it
  // is a gate that lies to every other caller.
  private shadowSkipFrames = 0;
  /** Frames the gate may skip after an empty pass before it must look again. */
  private static readonly SHADOW_RECHECK_FRAMES = 10;
  /** …and the wall-clock ceiling on the same window, which is what actually
   *  binds on a machine mid-load. Whichever runs out first ends the skip. */
  private static readonly SHADOW_RECHECK_MS = 250;
  private lastShadowPassAt = 0;
  /** Casters drawn by the last depth pass that actually ran. Diagnostics read
   *  it; the gate below is the only thing that writes it. */
  private lastShadowPassCalls = 0;
  private shadowPassesRun = 0;
  private shadowPassesSkipped = 0;

  private installShadowPassGate() {
    const shadowMap = this.renderer.shadowMap as THREE.WebGLShadowMap & {
      render: (lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => void;
    };
    if (!shadowMap.enabled) return;
    const info = this.renderer.info;
    const inner = shadowMap.render.bind(shadowMap);
    // three's `WebGLShadowMap.render` is an own function property, and the
    // difference across it is the only place the caster draw count exists: by
    // the time `renderer.render()` has returned, the main pass and the post
    // chain have been added to the same counter. The decision is taken here,
    // where the count is, rather than a frame later somewhere else.
    shadowMap.render = (lights, scene, camera) => {
      // ── EVERY FULL-SCREEN QUAD IS A `renderer.render` TOO ─────────────────
      // `FullScreenQuad.render()` is `renderer.render(quadScene, quadCamera)`,
      // and the post chain does fourteen of those a frame. Each one arrives
      // here with an EMPTY shadow-light array and a scene that is one quad, so
      // it "runs" a shadow pass, draws nothing, and — before this guard — was
      // read as "the world has no casters". Measured: 12 of every 15 passes
      // skipped at a dock vista that has 226 of them, with `lastCasterDraws`
      // pinned at zero forever.
      //
      // A render with no shadow-casting lights, or of a scene that is not the
      // world, is not the world's shadow pass and must not vote on it.
      if (!lights || lights.length === 0 || scene !== this.scene) {
        inner(lights, scene, camera);
        return;
      }
      // TEN FRAMES IS A SIXTH OF A SECOND AT 60 fps AND TEN SECONDS AT 1 fps.
      // The window this gate is allowed to be wrong in has to be a window in
      // TIME, or the machines that need the saving most — the ones rendering a
      // frame a second through a load — are the ones that spend ten seconds
      // with an island in front of them and no shadow under it.
      const now = performance.now();
      const stale = now - this.lastShadowPassAt > Renderer.SHADOW_RECHECK_MS;
      if (this.shadowSkipFrames > 0 && !stale) {
        this.shadowSkipFrames -= 1;
        this.shadowPassesSkipped += 1;
        return;
      }
      this.lastShadowPassAt = now;
      // `autoUpdate` is off (below), so three would early-return on its own
      // unless this says otherwise. Saying it here rather than a frame earlier
      // is what makes the gate hold for every caller.
      shadowMap.needsUpdate = true;
      const before = info.render.calls;
      inner(lights, scene, camera);
      const drawn = info.render.calls - before;
      this.lastShadowPassCalls = drawn;
      this.shadowPassesRun += 1;
      this.shadowSkipFrames = drawn === 0 ? Renderer.SHADOW_RECHECK_FRAMES : 0;
    };
    // From here the gate owns which frames pay for a depth pass.
    shadowMap.autoUpdate = false;
    shadowMap.needsUpdate = true;
  }

  /** What the debug overlay prints about the gate. */
  getShadowPassStats(): { mapSize: number; lastCasterDraws: number; run: number; skipped: number } {
    return {
      mapSize: this.sun?.castShadow ? this.sun.shadow.mapSize.x : 0,
      lastCasterDraws: this.lastShadowPassCalls,
      run: this.shadowPassesRun,
      skipped: this.shadowPassesSkipped,
    };
  }

  private applyShadowMapSize(size: number) {
    if (!this.sun.castShadow || this.sun.shadow.mapSize.x === size) return;
    // A resize drops the target, and a dropped target is blank until something
    // renders into it: never skip the frame after one.
    this.shadowSkipFrames = 0;
    this.sun.shadow.mapSize.set(size, size);
    // Force reallocation at the new size; the depth material is untouched, so
    // nothing recompiles.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
  }

  /** 0 = dry, 1 = full downpour. Couples falling-rain density into the
   *  atmosphere so distance reads WET, not merely dark. */
  setRainMist(amount: number) {
    const next = clamp(amount, 0, 1);
    if (Math.abs(next - this.rainMist) < 0.004) return;
    this.rainMist = next;
    // Force updateStormWeather's early-out to re-derive the fog next call.
    this.lastStormWeather = -1;
  }

  /** The rain volume the client is actually DRAWING (0 = dry, 1 = downpour), fed
   *  straight to the cloud deck so the sky over a squall always agrees with the
   *  water falling out of it. See the note over u_overcast in SKY_FRAG: the
   *  storm's own weather level runs at ~0.35 where the rain reaches inboard of
   *  the ring, and 0.35 of this shader's storm response is still open blue. */
  setOvercast(rain01: number) {
    this.skyMaterial.uniforms.u_overcast.value = clamp(rain01, 0, 1);
  }

  /** Strike lighting for the sky dome / cloud deck. `strength` is the bolt's
   *  0..1 brightness envelope; `dirX/dirZ` point from the camera toward it. */
  setLightningFlash(strength: number, dirX: number, dirZ: number) {
    this.skyMaterial.uniforms.u_lightningFlash.value = clamp(strength, 0, 1);
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      (this.skyMaterial.uniforms.u_lightningDir.value as THREE.Vector3).set(dirX / len, 0, dirZ / len);
    }
  }

  /** 0 = clear weather, 1 = full storm (gray sky, fog, dim lights). */
  updateStormWeather(intensity: number) {
    const t = clamp(intensity, 0, 1);
    if (Math.abs(t - this.lastStormWeather) < 0.008) return;
    this.lastStormWeather = t;
    this.stormLevel = t;
    this.skyMaterial.uniforms.u_stormIntensity.value = t;

    const fog = this.scene.fog as THREE.FogExp2;
    this.getCycleColor(this.tempFogColor, this.fogDayColor, this.fogTwilightColor, this.fogNightColor);
    fog.color.copy(this.tempFogColor).lerp(this.fogStormColor, t);
    fog.color.lerp(this.fogRainColor, this.rainMist * 0.4);
    fog.density = THREE.MathUtils.lerp(this.getCycleFogDensity(), 0.00255, t) * (1 + this.rainMist * 0.62);

    this.sun.intensity = THREE.MathUtils.lerp(this.getCycleSunIntensity(), this.getStormSunIntensity(), t);
    this.ambientLight.intensity = THREE.MathUtils.lerp(this.getCycleAmbientIntensity(), this.getStormAmbientIntensity(), t);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(this.getCycleHemisphereIntensity(), this.getStormHemisphereIntensity(), t);
    this.horizonFill.intensity = THREE.MathUtils.lerp(this.getCycleHorizonIntensity(), this.getStormHorizonIntensity(), t);
    // Re-derive from the cycle first: this path can be entered repeatedly at the
    // same storm level, and lerping a light that is already grey toward grey
    // again would walk the whole scene to slate over a few seconds.
    this.getCycleColor(this.sun.color, this.sunDayColor, this.sunTwilightColor, this.moonColor);
    this.getCycleColor(this.ambientLight.color, this.ambientDayColor, this.ambientTwilightColor, this.ambientNightColor);
    this.getCycleColor(this.hemisphereLight.color, this.hemiSkyDayColor, this.hemiSkyTwilightColor, this.hemiSkyNightColor);
    this.getCycleColor(this.hemisphereLight.groundColor, this.hemiGroundDayColor, this.hemiGroundTwilightColor, this.hemiGroundNightColor);
    this.getCycleColor(this.horizonFill.color, this.horizonDayColor, this.horizonTwilightColor, this.horizonNightColor);
    this.applyStormLightColors(t);
    this.applySpectateLift();
    this.setSunDiscWeather(t, 0);

    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(this.getCycleExposure(), this.getStormExposure(), t);
  }

  updateWaterEnvironment(depthBelowSurface: number, stormIntensity: number, elapsedSeconds = 0) {
    this.updateDayNight(elapsedSeconds);
    const storm = clamp(stormIntensity, 0, 1);
    this.stormLevel = storm;
    const depth = Math.max(0, depthBelowSurface);
    const underwater = clamp(depth / 1.45, 0, 1);
    const deep = clamp(depth / 28, 0, 1);

    this.skyMaterial.uniforms.u_stormIntensity.value = storm;
    this.skyMaterial.uniforms.u_underwaterIntensity.value = underwater;

    const fog = this.scene.fog as THREE.FogExp2;
    this.getCycleColor(this.tempFogColor, this.fogDayColor, this.fogTwilightColor, this.fogNightColor);
    this.tempFogColor.lerp(this.fogStormColor, storm);
    this.tempFogColor.lerp(this.fogRainColor, this.rainMist * 0.4);
    this.tempUnderwaterFogColor.copy(this.fogUnderwaterNearColor).lerp(this.fogUnderwaterDeepColor, deep);
    fog.color.copy(this.tempFogColor).lerp(this.tempUnderwaterFogColor, underwater);
    const weatherFog = THREE.MathUtils.lerp(this.getCycleFogDensity(), 0.00255, storm) * (1 + this.rainMist * 0.62);
    const waterFog = THREE.MathUtils.lerp(0.0058, 0.011, deep); // gentler falloff so silhouettes survive at depth
    fog.density = THREE.MathUtils.lerp(weatherFog, waterFog, underwater);

    this.getCycleColor(this.sun.color, this.sunDayColor, this.sunTwilightColor, this.moonColor);
    this.getCycleColor(this.ambientLight.color, this.ambientDayColor, this.ambientTwilightColor, this.ambientNightColor);
    this.getCycleColor(this.hemisphereLight.color, this.hemiSkyDayColor, this.hemiSkyTwilightColor, this.hemiSkyNightColor);
    this.getCycleColor(this.hemisphereLight.groundColor, this.hemiGroundDayColor, this.hemiGroundTwilightColor, this.hemiGroundNightColor);
    this.getCycleColor(this.horizonFill.color, this.horizonDayColor, this.horizonTwilightColor, this.horizonNightColor);
    this.applyStormLightColors(storm);
    // Submerged fill is TEAL, not grey: the fill light is standing in for light
    // that has already travelled through metres of water, so island slopes and
    // sea rocks below the waterline take a depth ramp instead of going to ink.
    if (underwater > 0.001) {
      this.ambientLight.color.lerp(this.underwaterFillColor, underwater * 0.8);
      this.hemisphereLight.color.lerp(this.underwaterFillColor, underwater * 0.8);
      this.hemisphereLight.groundColor.lerp(this.underwaterFloorColor, underwater * 0.85);
    }

    const sunBase = THREE.MathUtils.lerp(this.getCycleSunIntensity(), this.getStormSunIntensity(), storm);
    const ambientBase = THREE.MathUtils.lerp(this.getCycleAmbientIntensity(), this.getStormAmbientIntensity(), storm);
    const hemisphereBase = THREE.MathUtils.lerp(this.getCycleHemisphereIntensity(), this.getStormHemisphereIntensity(), storm);
    const horizonBase = THREE.MathUtils.lerp(this.getCycleHorizonIntensity(), this.getStormHorizonIntensity(), storm);
    this.sun.intensity = THREE.MathUtils.lerp(sunBase, THREE.MathUtils.lerp(0.22, 0.08, deep), underwater);
    // Below the surface the only thing shaping the sea floor and the island
    // slopes is fill light — the sun is all but gone and no lantern reaches. The
    // floors here are what stop a submerged shelf resolving to a black hole in
    // the water; they are raised WITH the murky-teal fog, so depth still reads.
    this.ambientLight.intensity = THREE.MathUtils.lerp(ambientBase, THREE.MathUtils.lerp(1.05, 0.72, deep), underwater);
    this.hemisphereLight.intensity = THREE.MathUtils.lerp(hemisphereBase, THREE.MathUtils.lerp(0.92, 0.62, deep), underwater);
    this.horizonFill.intensity = THREE.MathUtils.lerp(horizonBase, THREE.MathUtils.lerp(0.04, 0.015, deep), underwater);
    // Last, on top of the finished cycle/storm/underwater colours — see
    // applySpectateLift for why this is one light and not two.
    this.applySpectateLift();
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.getCycleExposure(), this.getStormExposure(), storm),
      THREE.MathUtils.lerp(0.98, 0.76, deep),
      underwater,
    );
    this.setSunDiscWeather(storm, underwater);
  }

  getSunDirection() {
    return this.sunDir;
  }

  render() {
    // Hand this frame's few brightest torches/lanterns to the fixed light pool
    // BEFORE anything is drawn (see LightBudget: the pool size never changes,
    // so no material ever re-links because a torch came into view).
    updateLightBudget(this.camera.position);
    // Sky dome follows camera so it always fills the background
    this.skyMesh.position.copy(this.camera.position);
    const sunPos = this.camera.position.clone().addScaledVector(this.sunDir, 2050);
    this.sunGlow.position.copy(sunPos);
    this.sunDisc.position.copy(sunPos);
    this.sunGlow.lookAt(this.camera.position);
    this.sunDisc.lookAt(this.camera.position);
    this.updateShadowFrustum();
    // Accumulate draw/tri counters across ALL passes for this frame — with
    // autoReset the post-fx composer wipes them per pass and the debug overlay
    // forever reads the final fullscreen quad ("draw 1 | tris 1").
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    // Pay three's deferred first-use bill for a few programs, and hold back the
    // ones that were not paid for — see ProgramWarmup. prepare()/release() are
    // written here, around the one render call, so they cannot drift apart: a
    // release that does not run leaves materials hidden.
    this.programWarmer.prepare(
      this.renderer,
      this.scene,
      this.camera,
      this.postFx?.getSceneRenderTarget() ?? null,
    );
    try {
      if (this.postFx) {
        this.postFx.render();
      } else {
        this.renderer.render(this.scene, this.camera);
      }
    } finally {
      this.programWarmer.release();
    }
  }

  /** Pre-pays shader program links so no frame of the load has to. */
  readonly programWarmer = new ProgramWarmer();

  /** Render target used by the real scene pass, or null when rendering direct. */
  getSceneRenderTarget(): THREE.WebGLRenderTarget | null {
    return this.postFx?.getSceneRenderTarget() ?? null;
  }

  /** True while the load path must not block: the gate holds unwarmed materials
   *  out of a frame rather than letting them link inside it. */
  setLoadGuard(active: boolean): void {
    this.programWarmer.setGuard(active);
  }

  /** Warm harder — a ceremony owns the screen and nobody is playing. */
  setWarmBoost(boosted: boolean): void {
    this.programWarmer.setBoosted(boosted);
  }

  /** Per-frame atmosphere snapshot for the ocean/other systems. Returned objects are reused. */
  getAtmosphere(): Atmosphere {
    const a = this.atmosphere;
    // THE SEA IS LIT BY WHAT IS ACTUALLY SHINING. This used to hand the ocean
    // this.sunDir — the astronomical sun — which is below the horizon for the
    // whole back half of every match, so the water's sunUp went to 0, its
    // diffuse went to 0, and the one large surface in frame lost its key light,
    // its specular and any sense of direction exactly when land and ships were
    // being moonlit by activeLightDir. The true sun rides along separately for
    // the warm sunset streak, which must NOT reappear under the moon.
    a.sunDir.copy(this.activeLightDir);
    a.sunDirTrue.copy(this.sunDir);
    a.moonness = 1 - this.sunAboveAmount;
    const fog = this.scene?.fog as THREE.FogExp2 | null;
    if (fog) { a.fogColor.copy(fog.color); a.fogDensity = fog.density; }
    this.getCycleColor(a.horizonColor, this.skyHorizonDayColor, this.skyHorizonTwilightColor, this.skyHorizonNightColor);
    a.horizonColor.lerp(this.skyHorizonStormColor, this.stormLevel);
    // Same inputs the land gets, normalised against their own noon values (see
    // OCEAN_* above): magnitude from the live intensities, hue at 45%.
    const noonAmbient = colorLuma(this.ambientDayColor) * 0.9
      + colorLuma(this.hemiSkyDayColor) * 1.34 * 0.5;
    const liveAmbient = colorLuma(this.ambientLight.color) * this.ambientLight.intensity
      + colorLuma(this.hemisphereLight.color) * this.hemisphereLight.intensity * 0.5;
    this.oceanLight(a.ambientColor, this.ambientLight.color, OCEAN_AMBIENT_NOON * liveAmbient / Math.max(1e-4, noonAmbient));
    this.oceanLight(a.keyColor, this.sun.color, OCEAN_KEY_NOON * this.sun.intensity / OCEAN_KEY_NOON_INTENSITY);
    a.storminess = this.stormLevel;
    a.nightFactor = this.nightAmount;
    a.twilightFactor = this.twilightAmount;
    return a;
  }

  /** One light expressed the way the water wants it: `magnitude` carries the
   *  truth, the source colour contributes OCEAN_LIGHT_TINT of its hue. */
  private oceanLight(target: THREE.Color, tint: THREE.Color, magnitude: number) {
    const l = Math.max(1e-4, colorLuma(tint));
    target.setRGB(
      THREE.MathUtils.lerp(1, tint.r / l, OCEAN_LIGHT_TINT),
      THREE.MathUtils.lerp(1, tint.g / l, OCEAN_LIGHT_TINT),
      THREE.MathUtils.lerp(1, tint.b / l, OCEAN_LIGHT_TINT),
    ).multiplyScalar(Math.max(0, magnitude));
  }

  /** Keeps a tight shadow ortho box centered ahead of the camera, snapped to shadow texels. */
  private updateShadowFrustum() {
    if (!this.sun.castShadow) return;
    const halfExtent = this.shadowHalfExtent();
    if (this.appliedShadowExtent !== halfExtent) {
      this.appliedShadowExtent = halfExtent;
      const cam = this.sun.shadow.camera;
      cam.left = -halfExtent;
      cam.right = halfExtent;
      cam.top = halfExtent;
      cam.bottom = -halfExtent;
      cam.updateProjectionMatrix();
    }
    this.camera.getWorldDirection(this.cameraForward);
    this.cameraForward.y = 0;
    if (this.cameraForward.lengthSq() < 1e-4) this.cameraForward.set(0, 0, 1);
    else this.cameraForward.normalize();
    // Anchor at sea level so wave/camera bob doesn't shift the frustum vertically.
    this.shadowFocus.copy(this.camera.position).addScaledVector(this.cameraForward, halfExtent * 0.7);
    this.shadowFocus.y = 0;

    // Snap the focus to the shadow-texel grid in light space to stop edge crawling.
    const texel = (halfExtent * 2) / this.sun.shadow.mapSize.x;
    this.shadowBasis.lookAt(this.activeLightDir, SHADOW_ORIGIN, SHADOW_UP);
    this.shadowBasisInv.copy(this.shadowBasis).invert();
    this.shadowFocus.applyMatrix4(this.shadowBasisInv);
    this.shadowFocus.x = Math.round(this.shadowFocus.x / texel) * texel;
    this.shadowFocus.y = Math.round(this.shadowFocus.y / texel) * texel;
    this.shadowFocus.applyMatrix4(this.shadowBasis);

    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.activeLightDir, SHADOW_LIGHT_DISTANCE);
  }

  private setSunDiscWeather(storm: number, underwater: number) {
    const sunAbove = smoothstep(-0.04, 0.1, this.sunDir.y);
    const visibility = (1 - clamp(storm, 0, 1) * 0.86) * (1 - clamp(underwater, 0, 1)) * sunAbove;
    const discMat = this.sunDisc?.material as THREE.MeshBasicMaterial | undefined;
    const glowMat = this.sunGlow?.material as THREE.MeshBasicMaterial | undefined;
    if (discMat) {
      this.getCycleColor(discMat.color, this.sunDayColor, this.sunTwilightColor, this.moonColor);
      discMat.opacity = 0.84 * visibility * (0.85 + this.twilightAmount * 0.25);
    }
    if (glowMat) {
      this.getCycleColor(glowMat.color, this.horizonDayColor, this.horizonTwilightColor, this.moonColor);
      glowMat.opacity = (0.12 + this.twilightAmount * 0.22) * visibility;
    }
  }

  private updateDayNight(elapsedSeconds: number) {
    const cycle = positiveModulo(elapsedSeconds / DAY_NIGHT_CYCLE_SECONDS + DAY_NIGHT_START_OFFSET, 1);
    const daylightShare = 0.72;
    const sunArc = cycle < daylightShare
      ? (cycle / daylightShare) * Math.PI
      : Math.PI + ((cycle - daylightShare) / (1 - daylightShare)) * Math.PI;
    const rawY = Math.sin(sunArc);
    const horizontal = Math.sqrt(Math.max(0.001, 1 - rawY * rawY));
    const azimuth = cycle * Math.PI * 2 * 0.62 - 0.74;
    this.sunDir.set(Math.cos(azimuth) * horizontal, rawY, Math.sin(azimuth) * horizontal).normalize();

    const dayRaw = smoothstep(-0.03, 0.26, rawY);
    const nightRaw = 1 - smoothstep(-0.32, 0.05, rawY);
    const twilightRaw = clamp(1 - Math.abs(rawY) / 0.34, 0, 1) * (1 - nightRaw * 0.18);
    const total = Math.max(0.001, dayRaw + twilightRaw + nightRaw);
    this.dayAmount = dayRaw / total;
    this.twilightAmount = twilightRaw / total;
    this.nightAmount = nightRaw / total;

    this.skyMaterial.uniforms.u_sunDir.value.copy(this.sunDir);
    this.skyMaterial.uniforms.u_dayAmount.value = this.dayAmount;
    this.skyMaterial.uniforms.u_twilightAmount.value = this.twilightAmount;
    this.skyMaterial.uniforms.u_nightAmount.value = this.nightAmount;
    this.skyMaterial.uniforms.u_time.value = elapsedSeconds;

    const sunAbove = smoothstep(-0.06, 0.12, this.sunDir.y);
    this.sunAboveAmount = sunAbove;
    this.activeLightDir.copy(this.sunDir);
    if (sunAbove <= 0.08) this.activeLightDir.multiplyScalar(-1);
    this.activeLightDir.y = Math.max(0.16, this.activeLightDir.y);
    this.activeLightDir.normalize();
    this.sun.position.copy(this.activeLightDir).multiplyScalar(400);
    this.horizonFill.position.copy(this.activeLightDir).multiplyScalar(-340);
    this.horizonFill.position.y = Math.max(28, this.horizonFill.position.y);
  }

  /** Pull every scene light toward its storm swatch. Call AFTER the day/night
   *  colours are written and BEFORE any underwater tint, so a submerged dive
   *  inside a squall still ends up teal rather than grey. */
  private applyStormLightColors(storm: number) {
    if (storm <= 0.001) return;
    this.sun.color.lerp(this.sunStormColor, storm * 0.85);
    this.ambientLight.color.lerp(this.ambientStormColor, storm * 0.9);
    this.hemisphereLight.color.lerp(this.hemiSkyStormColor, storm * 0.9);
    this.hemisphereLight.groundColor.lerp(this.hemiGroundStormColor, storm * 0.9);
    this.horizonFill.color.lerp(this.horizonFillStormColor, storm * 0.85);
  }

  /**
   * THE SPECTATE FILL IS NOT A SECOND LIGHT, AND IT MUST NOT BE.
   *
   * `numHemiLights` is a field of three's program cache key
   * (`WebGLPrograms.getProgramCacheKeyParameters`, right beside the point-light
   * count LightBudget exists to pin). The death camera used to answer its lift
   * by CONSTRUCTING a `THREE.HemisphereLight` and adding it to the scene the
   * first time a player died, and hiding it again when the lift decayed. Every
   * one of those transitions moved the count 1 ↔ 2 and re-linked EVERY MATERIAL
   * IN THE WORLD.
   *
   * Measured, `high`, 90 s, pinned map, program census: 31 of 135 program keys
   * were pure duplicates of a program already linked and paid for, differing in
   * exactly one field — `numHemiLights`, 1 vs 2 — and 24 of the 40 links taken
   * inside a drawn frame during play landed in one 600 ms window at the moment
   * the spectate camera rose. The player dies and the client re-links the map.
   *
   * WHY FOLDING IT IN IS EXACT AND NOT AN APPROXIMATION. Both lights are
   * hemispheres, and three shades a hemisphere as
   * `mix(groundColor, skyColor, w)` where `w` depends only on the surface
   * normal — the SAME `w` for both — with the intensity already multiplied into
   * the colours (`WebGLLights.setup`). So
   *
   *   I₁·mix(G₁,S₁,w) + I₂·mix(G₂,S₂,w)
   *     = (I₁+I₂)·mix( lerp(G₁,G₂,k), lerp(S₁,S₂,k), w ),  k = I₂/(I₁+I₂)
   *
   * for every normal. One light carrying the summed intensity and the
   * intensity-weighted colours is the same radiance the two lights produced, to
   * the last bit, and costs one fewer light in the fragment loop of every lit
   * pixel in the game rather than one more.
   *
   * Called at the END of both writers of the hemisphere light, each of which
   * re-derives its colours from the day/night cycle before it runs, so the lift
   * is applied to a fresh base every frame and cannot accumulate.
   */
  private applySpectateLift() {
    const lift = this.spectateLift;
    if (lift <= 0.001) return;
    const added = Renderer.SPECTATE_FILL_INTENSITY * lift;
    const total = this.hemisphereLight.intensity + added;
    if (total <= 1e-5) return;
    const k = added / total;
    this.hemisphereLight.color.lerp(this.spectateSkyColor, k);
    this.hemisphereLight.groundColor.lerp(this.spectateGroundColor, k);
    this.hemisphereLight.intensity = total;
  }

  /** What the death camera's fill was worth as its own light. */
  private static readonly SPECTATE_FILL_INTENSITY = 0.85;
  private readonly spectateSkyColor = new THREE.Color(0xbcd2ee);
  private readonly spectateGroundColor = new THREE.Color(0x243040);
  private spectateLift = 0;

  /** 0 = alive and on your feet, 1 = the death camera fully risen. Game owns the
   *  ramp; this only says how much fill it is asking for. */
  setSpectateLift(lift: number): void {
    this.spectateLift = clamp(Number.isFinite(lift) ? lift : 0, 0, 1);
  }

  private getCycleColor(target: THREE.Color, day: THREE.Color, twilight: THREE.Color, night: THREE.Color) {
    target.setRGB(
      day.r * this.dayAmount + twilight.r * this.twilightAmount + night.r * this.nightAmount,
      day.g * this.dayAmount + twilight.g * this.twilightAmount + night.g * this.nightAmount,
      day.b * this.dayAmount + twilight.b * this.twilightAmount + night.b * this.nightAmount,
    );
    return target;
  }

  private getCycleSunIntensity() {
    // The night term is MOONLIGHT (activeLightDir flips to the anti-sun once the
    // sun is down). It is the only directional light after dark, so it has to be
    // strong enough to shape a hull/cliff into a silhouette — a Sea-of-Thieves
    // night is blue and legible, not an unlit black screen.
    return this.dayAmount * 2.65 + this.twilightAmount * 1.55 + this.nightAmount * 0.62;
  }

  private getCycleAmbientIntensity() {
    // Raised so slopes facing away from an overhead sun read as deep colour, not
    // black — the shaded side of an island should still show its biome tone.
    // Twilight fill is kept LOWER than day: the low dusk sun must still shape the
    // terrain (directional warm light + long shadows), so fill can't out-power it.
    return this.dayAmount * 0.9 + this.twilightAmount * 0.58 + this.nightAmount * 0.78;
  }

  private getCycleHemisphereIntensity() {
    // Sky/ground fill is the main lever that keeps steep terrain readable; it is
    // normal-oriented so it lifts shaded faces without flattening lit ones.
    return this.dayAmount * 1.34 + this.twilightAmount * 0.78 + this.nightAmount * 0.86;
  }

  private getCycleHorizonIntensity() {
    return this.dayAmount * 0.3 + this.twilightAmount * 0.42 + this.nightAmount * 0.16;
  }

  // ── Storm light targets ───────────────────────────────────────────────────
  // A storm dims the world toward these; they used to be flat constants, which
  // meant a storm AT NIGHT stacked its dimming on top of an already-dark cycle
  // and drove the whole frame to black (only the HUD survived). The floors now
  // rise with nightAmount, so a night storm is a dark BLUE squall you can still
  // read a deck and a coastline through.
  private getStormSunIntensity() { return 0.42 + this.nightAmount * 0.16; }
  private getStormAmbientIntensity() { return 0.36 + this.nightAmount * 0.40; }
  private getStormHemisphereIntensity() { return 0.28 + this.nightAmount * 0.50; }
  private getStormHorizonIntensity() { return 0.08 + this.nightAmount * 0.06; }
  private getStormExposure() { return 0.78 + this.nightAmount * 0.22; }

  private getCycleExposure() {
    return this.dayAmount * 1.06 + this.twilightAmount * 1.12 + this.nightAmount * 1.08;
  }

  private getCycleFogDensity() {
    // Thinned a notch across the cycle: combined with the darker fog tint above,
    // an 800m island still reads as a shape instead of dissolving into haze.
    return this.dayAmount * 0.00112 + this.twilightAmount * 0.00146 + this.nightAmount * 0.00158;
  }

  /**
   * SET THE RATIO, OR DO NOTHING AT ALL.
   *
   * `setPixelRatio` is not a scalar assignment: three re-enters `setSize`, which
   * resizes the drawing buffer, and the post chain resizes every one of its
   * targets behind it. That is a swapchain reallocation, and this used to run
   * unconditionally — including on every window `resize` event and every ladder
   * step that landed on the ratio it was already at. A 180-second capture in
   * which no window was ever resized spent 19,488 ms inside
   * WebGLRenderer.setSize, with one 1,644 ms hitch attributed to it (§9 lever
   * 7). The `force` path exists for the one caller that genuinely needs the
   * reallocation with an unchanged ratio: an actual window resize.
   */
  private applyPixelRatio(target: number, force = false) {
    const deviceRatio = window.devicePixelRatio || 1;
    const viewportCap = window.innerWidth < 900 ? Math.min(this.maxPixelRatio, 0.72) : this.maxPixelRatio;
    const next = clamp(Math.min(deviceRatio, target, viewportCap), this.minPixelRatio, this.maxPixelRatio);
    // A tenth of a percent of a pixel is not a resolution change; it is a
    // reallocation with no picture behind it.
    if (!force && Math.abs(next - this.currentPixelRatio) < 0.001 && this.renderer) return;
    this.currentPixelRatio = next;
    this.renderer?.setPixelRatio(next);
    this.postFx?.setPixelRatio(next);
  }

  /** How wide the shadow ortho box is right now. The governor shrinks it late
   *  on the ladder: a smaller box draws fewer casters into the depth pass and
   *  raises the texel density of the ones that are left, and it changes no
   *  program — unlike switching shadows off, which re-links the whole scene. */
  private shadowHalfExtent(): number {
    return SHADOW_HALF_EXTENT * this.levers.shadowExtentScale;
  }
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}
