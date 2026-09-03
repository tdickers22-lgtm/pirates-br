import * as THREE from 'three';
import { WAVE_PARAMS, STORM_WAVE_PARAMS, getOceanRoughness, gerstnerHeight } from '../../shared/utils/index.js';
import type { RenderQuality } from './Renderer.js';

const MAX_ISLANDS = 16;

// GLSL is generated from the shared WAVE_PARAMS / STORM_WAVE_PARAMS so the
// rendered surface is the same field gameplay samples via
// gerstnerHeight(x, z, t, WAVE_PARAMS, storm): vertical-only displacement,
// base amplitude × getOceanRoughness(t) × (1 + storm·0.85), plus the dedicated
// storm swell × storm, where storm is the shared getStormWaveIntensity()
// replicated exactly in stormWaveIntensity() below. The only rendering
// liberties are a per-wave distance fade (keeps far coarse cells above Nyquist,
// sub-10cm and >90m from camera) and slight shore damping near islands.
const fmt = (n: number) => n.toFixed(6);

const waveComponentGlsl = (
  w: { amplitude: number; wavelength: number; direction: { x: number; y: number }; speed: number },
  ampExpr: string,
  indent: string,
) => {
  const len = Math.hypot(w.direction.x, w.direction.y);
  const dx = w.direction.x / len;
  const dz = w.direction.y / len;
  const k = (2 * Math.PI) / w.wavelength;
  const fadeStart = w.wavelength * 9;
  const fadeEnd = w.wavelength * 20;
  return `${indent}f = ${fmt(k)} * (dot(vec2(${fmt(dx)}, ${fmt(dz)}), p) - ${fmt(w.speed)} * u_time);
${indent}a = ${fmt(w.amplitude)} * ${ampExpr} * (1.0 - smoothstep(${fmt(fadeStart)}, ${fmt(fadeEnd)}, camDist));
${indent}h += a * sin(f);
${indent}c = a * ${fmt(k)} * cos(f);
${indent}dhx += c * ${fmt(dx)};
${indent}dhz += c * ${fmt(dz)};`;
};

const WAVE_FIELD_GLSL = `
  // Local storm sea-state in 0..1 — EXACT GLSL replica of the shared
  // getStormWaveIntensity(): full swell inside the deadly ring, ramp across a
  // 180m band around its edge, late-phase ambient chop everywhere.
  // u_stormSafeRadius < 0 means "no storm" (matches storm == null on the CPU).
  float stormWaveIntensity(vec2 p) {
    if (u_stormSafeRadius < -0.5) return 0.0;
    float distOutside = length(p - u_stormCenter) - u_stormSafeRadius;
    float edge = smoothstep(-140.0, 40.0, distOutside);
    float ambient = u_stormPhase01 * 0.38;
    return clamp(max(edge * (0.55 + u_stormPhase01 * 0.45), ambient), 0.0, 1.0);
  }

  // Returns vec3(height, dHeight/dx, dHeight/dz) of the shared Gerstner field
  // gerstnerHeight(x, z, t, WAVE_PARAMS, storm). Identical GLSL runs in both
  // the vertex and fragment stages so analytic normals match displacement.
  vec3 waveField(vec2 p, float camDist) {
    float storm = stormWaveIntensity(p);
    float rough = u_roughness * (1.0 + storm * 0.85);
    float h = 0.0; float dhx = 0.0; float dhz = 0.0;
    float f; float a; float c;
${WAVE_PARAMS.map((w) => waveComponentGlsl(w, 'rough', '    ')).join('\n')}
    if (storm > 0.0) {
${STORM_WAVE_PARAMS.map((w) => waveComponentGlsl(w, 'storm', '      ')).join('\n')}
    }
    return vec3(h, dhx, dhz);
  }
`;

const SHORE_GLSL = `
  // Approx signed distance (m) to the nearest island waterline. Each island is
  // an elliptical footprint vec4(centerX, centerZ, rx, rz); the normalized
  // ellipse distance is rescaled to meters by the minor half-extent, which is
  // exact on the minor axis and slightly conservative on the major one.
  float shoreDist(vec2 p) {
    float d = 100000.0;
    for (int i = 0; i < ${MAX_ISLANDS}; i++) {
      if (i >= u_islandCount) break;
      vec4 isl = u_islands[i];
      vec2 q = (p - isl.xy) / isl.zw;
      d = min(d, (length(q) - 1.0) * min(isl.z, isl.w));
    }
    return d;
  }
`;

const OCEAN_VERT = /* glsl */`
  uniform float u_time;
  uniform float u_roughness;
  uniform vec3  u_cameraPos;
  uniform vec4  u_islands[${MAX_ISLANDS}];
  uniform int   u_islandCount;
  uniform vec2  u_stormCenter;
  uniform float u_stormSafeRadius;
  uniform float u_stormPhase01;

  varying vec3  v_worldPos;
  varying float v_height;
  varying float v_shoreDamp;

  ${WAVE_FIELD_GLSL}
  ${SHORE_GLSL}

  void main() {
    // Grid tiles are children of a translated group: modelMatrix is a pure
    // translation snapped to the coarsest cell, so world lattice never swims.
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    float camDist = distance(u_cameraPos.xz, wp.xz);

    // Slight rendering-only wave damping in island shallows. Floor kept at
    // 0.85 so the drawn surface stays within ~15% of the shared physics field
    // (which applies no shore damping yet — see INTEGRATION_NOTES).
    v_shoreDamp = mix(0.85, 1.0, smoothstep(-8.0, 34.0, shoreDist(wp.xz)));

    float h = waveField(wp.xz, camDist).x * v_shoreDamp;
    wp.y += h;

    v_worldPos = wp;
    v_height   = h;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const OCEAN_FRAG = /* glsl */`
  uniform float u_time;
  uniform vec3  u_sunDir;
  uniform vec3  u_cameraPos;
  uniform float u_stormIntensity;
  uniform float u_underwaterDepth;
  uniform float u_roughness;
  uniform float u_nightFactor;
  uniform float u_twilightFactor;
  uniform vec3  u_fogColor;
  uniform vec3  u_horizonColor;
  // The scene's own lights, calibrated in Renderer.getAtmosphere so that at NOON
  // u_ambient is 0.48 and u_keyLight is 0.62 — the two constants that used to be
  // the ocean's entire light model. u_sunDir is now the ACTIVE light (moon after
  // dusk); u_sunDirTrue is the astronomical sun, for the sunset terms only.
  uniform vec3  u_keyLight;
  uniform vec3  u_ambient;
  uniform vec3  u_sunDirTrue;
  uniform float u_moonness;
  uniform vec4  u_islands[${MAX_ISLANDS}];
  uniform int   u_islandCount;
  uniform vec2  u_stormCenter;
  uniform float u_stormSafeRadius;
  uniform float u_stormPhase01;
  // Lightning response: 0..1 strike envelope + the horizontal direction from the
  // camera toward the bolt, so the sea glints along the strike azimuth.
  uniform float u_boltFlash;
  uniform vec2  u_boltDir;

  varying vec3  v_worldPos;
  varying float v_height;
  varying float v_shoreDamp;

  ${WAVE_FIELD_GLSL}
  ${SHORE_GLSL}

  // Smooth pseudo-random for detail foam / ripples
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i),
          b = hash(i + vec2(1,0)),
          c = hash(i + vec2(0,1)),
          d = hash(i + vec2(1,1));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
  }

  // Multi-octave scrolling height field used to derive fine ripple normals.
  // Shading detail only — it never moves geometry, so the visual surface still
  // matches the shared gerstnerHeight() the gameplay code samples.
  float rippleField(vec2 p) {
    float n = 0.0;
    n += noise(p * 0.60 + u_time * vec2( 0.06,  0.04)) * 0.60;
    n += noise(p * 1.70 - u_time * vec2( 0.05,  0.09)) * 0.28;
    n += noise(p * 4.10 + u_time * vec2( 0.11, -0.07)) * 0.14;
    return n;
  }

  // The sky dome authors its gradient in DISPLAY-referred values and shapes them
  // to linear at the end (see Renderer's SKY_FRAG) so ACES + sRGB lands back on
  // what was authored. The ocean does not: its palette is tuned directly in
  // linear. Feeding a sky swatch straight into the water therefore lands ~1.7x
  // too bright — which is what turned the far sea into a flat white plate with a
  // hard rim wherever the horizon lifted into frame. This is the sky's exact
  // shaping curve, applied only where the water is supposed to BE the sky.
  vec3 skyShape(vec3 c) {
    vec3 d = pow(max(c, vec3(0.0)), vec3(0.4545));
    return d * d * d * 0.55 + d * 0.06;
  }

  void main() {
    vec2  wp = v_worldPos.xz;
    float camDist = distance(u_cameraPos.xz, wp);
    // camDist is HORIZONTAL — the wave field's per-component fade is matched to
    // the shared gerstnerHeight() the physics samples, and that has to stay a
    // function of ground distance or a ship 300 m below the crow's nest floats
    // on water drawn flat. Every SHADING fade below uses the true eye distance
    // instead: from altitude a patch 100 m out horizontally is 400 m away and a
    // few pixels wide, and running ripple normals, whitecap breakup and a tight
    // specular lobe at that footprint is precisely the far-ocean moiré.
    float viewDist = distance(u_cameraPos, v_worldPos);

    // Analytic per-pixel normal: displacement is vertical-only, so xz is
    // undistorted and the derivative field matches the drawn surface exactly.
    vec3 wf = waveField(wp, camDist);
    vec3 N = normalize(vec3(-wf.y * v_shoreDamp, 1.0, -wf.z * v_shoreDamp));

    // Local storm sea-state (same value waveField used for displacement).
    float stormSea = stormWaveIntensity(wp);

    vec3 V = normalize(u_cameraPos - v_worldPos);
    vec3 L = normalize(u_sunDir);
    // The TRUE sun, which is under the horizon all night. Only the warm sunset
    // streak may key off it — hand it to the diffuse or the specular and the
    // whole sea goes unlit the moment the sun sets, which is what it did.
    vec3 S = normalize(u_sunDirTrue);
    // The two lights as one "how bright is it out" scale, normalised to 1.0 at
    // noon (0.48 + 0.62*0.55 = 0.821). Terms that are not albedo — foam, spray,
    // the shore film — used to carry their own hand-rolled night mix; they ride
    // this instead, so a change to the scene's lights moves them too.
    vec3 lightScale = (u_ambient + u_keyLight * 0.55) / 0.821;

    // How far the EYE sits above this patch of surface. Swimming or wading, the
    // whole visible sea is at grazing incidence, and both the shallow tint and
    // the ripple-detail range have to know about it.
    float eyeAbove = max(0.0, u_cameraPos.y - v_worldPos.y);
    float lowEye = 1.0 - smoothstep(0.10, 0.55, eyeAbove);

    // How STEEPLY this patch is being looked at: eye height over ground run.
    // Everything the shoreline SDF paints — the turquoise sand shelf, the film
    // of lap foam — is a top-down read of the seabed, and eye height alone does
    // not say whether you are looking DOWN into it. From a deck 6 m up, water
    // 200 m ahead is at 1.7 degrees, yet it was served the full overhead sand
    // tint: that is the flat pale ellipse that sat ahead of the bow, brightest
    // at night against dark water, wearing the exact shape of the island
    // footprint that seeded it. Below ~2 degrees the shelf hands over to the
    // reflected sky; look down into the lagoon and it comes straight back.
    float sightPitch = eyeAbove / max(1.0, camDist);
    float topDown = smoothstep(0.03, 0.30, sightPitch);

    // ── Fine ripple detail normals: fade with distance (specular AA),
    //    flatten on gentle days, churn harder inside the storm ──────────
    float calm = clamp((u_roughness - 0.55) / 1.05, 0.0, 1.0);
    // From eye level the surface stretches away in extreme perspective, so the
    // usual 40m detail horizon put the flat, normal-free half of the ocean
    // directly across the middle of the frame — the flat cyan sheet. Standing in
    // the water pushes the ripple normals out with the horizon.
    float wading = 1.0 - smoothstep(0.25, 2.20, eyeAbove);
    float detailFade = 1.0 - smoothstep(40.0 + 120.0 * wading, 560.0 + 520.0 * wading, viewDist);
    if (detailFade > 0.001) {
      float e  = 0.85;
      float h0 = rippleField(wp);
      float hx = rippleField(wp + vec2(e, 0.0));
      float hz = rippleField(wp + vec2(0.0, e));
      float rippleAmp = (0.9 + 1.5 * calm + 1.1 * stormSea) * detailFade;
      N = normalize(N + vec3(-(hx - h0), 0.0, -(hz - h0)) * rippleAmp);
    }

    // ── Base water color: deep troughs to lifted flanks. Height is
    //    normalized against the storm-boosted expected swell so hn keeps
    //    tracking crest/trough across sea states; storm steepens the
    //    trough/crest contrast and pulls the palette slate-dark ──────────
    float ampNorm = u_roughness * 0.70 * (1.0 + stormSea * 0.85) + stormSea * 1.85;
    float hn = clamp(v_height / max(0.22, ampNorm), -1.0, 1.0);
    float flank = clamp(hn * (0.32 + 0.18 * stormSea) + 0.5, 0.0, 1.0);
    vec3 deep   = mix(vec3(0.008, 0.09, 0.28), vec3(0.004, 0.045, 0.15), stormSea);
    vec3 lifted = mix(vec3(0.045, 0.30, 0.50), vec3(0.11, 0.33, 0.44), stormSea);
    vec3 base   = mix(deep, lifted, flank);

    // ── Shore shallows: turquoise ramp toward the beach ─────────────────
    float sd = shoreDist(wp);
    float shallowMask = 1.0 - smoothstep(4.0, 52.0, sd);
    // The sand-depth tint is a TOP-DOWN read: at 20cm of eye height there is no
    // sand path through the water to see, so lowEye (computed above) fades it out
    // and the reflected sky takes over instead.
    // Richer, slightly deeper turquoise so shallows read as tropical water, not a
    // pale wash that the specular then blows to white.
    vec3 shallowCol = mix(vec3(0.04, 0.40, 0.50), vec3(0.10, 0.62, 0.62), 1.0 - smoothstep(0.0, 14.0, sd));
    // The shallow ramp is SUNLIGHT scattering off white sand: it needs a sun to
    // exist. Ungated, a lagoon glowed radioactive cyan under a moonless sky with
    // no light source anywhere in frame. At night it collapses to a dim moonlit
    // blue-teal that the moon path and lantern pools can still play over.
    float shoreLight = 1.0 - u_nightFactor * 0.82;
    shallowCol = mix(shallowCol, vec3(0.020, 0.085, 0.145), u_nightFactor * 0.85);
    // A squall does not leave the lagoon tropical. Under storm cloud the sand
    // shelf loses the sun that scatters off it: the turquoise greys out and
    // darkens toward the slate the open water is already taking.
    float shallowGrey = dot(shallowCol, vec3(0.299, 0.587, 0.114));
    shallowCol = mix(shallowCol, vec3(shallowGrey) * 0.62, u_stormIntensity * 0.85);
    float shallowMix = shallowMask * 0.9
      * (1.0 - u_stormIntensity * 0.55)
      * (1.0 - u_twilightFactor * 0.42)
      * shoreLight
      * mix(0.16, 1.0, topDown);
    base = mix(base, shallowCol, shallowMix);

    // ── Fresnel reflectance toward sky/horizon ──────────────────────────
    float NdotV   = max(0.0, dot(N, V));
    float fresnel = 0.028 + 0.972 * pow(1.0 - NdotV, 5.0);
    // Warm reflection streak only when the sun sits low (sunrise/sunset).
    float sunLow  = 1.0 - smoothstep(0.16, 0.48, S.y);
    // The KEY light's own elevation — the sun by day, the moon by night, and
    // never below 0.16 — so there is a specular lobe after dark to carry the
    // moon path. The old sunUp = smoothstep(-0.06, 0.10, L.y) went to 0 the
    // moment the sun set and took every highlight on the sea with it. sunLow /
    // sunPath above stay on the TRUE sun, so the warm sunset streak they tint
    // does not reappear at midnight under the moon.
    float keyUp   = smoothstep(-0.06, 0.10, L.y);
    float sunPath = pow(max(0.0, dot(normalize(vec3(V.x, 0.14, V.z)), normalize(vec3(S.x, 0.14, S.z)))), 5.0);
    // The sky the water mirrors, shaped the way the sky dome shapes itself, so
    // the reflection dims with the sky at night instead of staying a daylight
    // blue constant: this term, not the body colour, is what carried the night
    // inversion at grazing angles.
    vec3 skyTint = skyShape(u_horizonColor);
    vec3 reflCol = mix(vec3(0.38, 0.54, 0.82) * lightScale, skyTint, 0.42);
    reflCol = mix(reflCol, vec3(1.0, 0.55, 0.30), sunPath * sunLow * 0.6);
    base = mix(base, reflCol, fresnel * 0.42);

    // ── Grazing incidence: water seen almost edge-on is a MIRROR ────────
    // Near-eye-level over a white-sand shelf the old shader still served the
    // top-down shallow tint at full strength, so the last few metres of lagoon
    // read as one opaque cyan/grey sheet with no surface in it. At grazing
    // angles the shallow body colour hands over to the sky it reflects, and
    // because the blend rides the per-pixel ripple normal the sheet breaks back
    // up into moving water.
    // The sky it reflects is looked up through the REFLECTED ray, not taken as a
    // constant: neighbouring ripples point at different parts of the dome (a wave
    // face tilted toward the eye reflects the deeper blue overhead, its back
    // reflects the pale horizon), so the mirror term carries the surface texture
    // instead of erasing it. A flat lerp to one horizon colour was still a sheet
    // — just a paler one.
    vec3 R = reflect(-V, N);
    float rUp = clamp(R.y, 0.0, 1.0);
    vec3 zenithCol = skyTint * vec3(0.46, 0.62, 0.95);
    // The lookup band is deliberately NARROW: at eye level every reflected ray
    // leaves the surface within a few degrees of the horizon, so a wide ramp
    // reads back the same horizon colour for every ripple and the sheet stays
    // flat. Across 0..0.09 of R.y the ripples separate into visible bands.
    vec3 skyRefl = mix(skyTint, zenithCol, smoothstep(0.004, 0.090, rUp));
    float graze = smoothstep(0.30, 0.015, NdotV);
    vec3 grazeCol = mix(skyRefl, base, 0.34);
    base = mix(base, grazeCol, graze * (0.30 + 0.42 * shallowMask) * (0.35 + 0.65 * lowEye));

    // ── Diffuse key light ───────────────────────────────────────────────
    float diff = max(0.0, dot(N, L));
    base *= u_ambient + u_keyLight * diff;

    // ── Blinn specular: lobe widens with distance (specular AA), energy
    //    drops with it, and the HDR result is clamped — no firefly noise ─
    vec3  H = normalize(L + V);
    float NdotH = max(0.0, dot(N, H));
    float lobeWiden = max(smoothstep(90.0, 1400.0, viewDist), u_stormIntensity * 0.5);
    // Keep a higher shininess floor at low sun so the sunset reflection stays a
    // fine shimmering glitter path, not big hard red paint-splat blobs.
    float shininess = mix(310.0, mix(46.0, 130.0, sunLow), lobeWiden);
    float spec  = pow(NdotH, shininess) * mix(1.9, 0.5, lobeWiden) * (1.0 - sunLow * 0.35);
    float glare = pow(NdotH, 24.0) * 0.1;
    // keyUp, not sunUp: the lobe follows whatever is in the sky. Moonlight is a
    // reflected-sunlight source about a millionth as strong, so the path is
    // dimmed rather than removed — 0.35 keeps a legible glitter column without
    // painting a second sunset on the water.
    vec3 specCol = mix(vec3(1.0, 0.94, 0.80), vec3(1.0, 0.50, 0.28), sunPath * sunLow)
                 * (spec + glare) * keyUp * mix(1.0, 0.35, u_moonness);
    specCol = min(specCol, vec3(1.15));
    specCol = mix(specCol, specCol * vec3(0.62, 0.74, 1.05), u_nightFactor);

    // ── Foam: noise-broken crests + animated shore band. Storm lowers the
    //    breaking threshold and softens the exponent so whitecap coverage
    //    grows dramatically as the sea state rises ─────────────────────────
    // Whitecap coverage thins with distance in a storm — full-strength crest
    // foam at every range merged into a horizon-wide ice sheet (patrol-1).
    float stormFoamFade = 1.0 - smoothstep(220.0, 1400.0, viewDist) * max(u_stormIntensity, stormSea) * 0.8;
    // ── THE CHEQUERBOARD FROM ALTITUDE ──────────────────────────────────────
    // From 120 m up the open sea became a periodic grid of pale blotches with
    // rows of streaks converging on the vanishing point, at every hour. Neither
    // was aliasing: the blotches are one whitecap per swell crest and the
    // streaks are one swell component's crest LINES, and the reason they read as
    // a lattice is that the thing that breaks foam up had been switched off out
    // there. The breakup term was gated by detailFade — which is calibrated for the
    // 0.85 m ripple DERIVATIVES and is gone by 560 m — while the field it gates
    // has 8-18 m features that are still 15 px across at 300 m and perfectly
    // resolvable at a kilometre. So past the ripple horizon foam collapsed to a
    // constant 0.32 of the crest term, i.e. to the wave field's own period,
    // drawn clean. Foam breakup now gets a range gate matched to the scale of
    // the noise it actually samples.
    float breakupRange = 1.0 - smoothstep(900.0, 2400.0, viewDist);
    // Whitecaps still have to LOD out: broken up or not, a cap is a metre-scale
    // feature, and from altitude one band of the frame holds dozens of swell
    // periods at once — which is exactly when the eye starts reading a grid
    // rather than water. Altitude pulls the handover nearer, and what it hands
    // over to is the flat base colour the horizon dissolve is already walking
    // toward. Eye level keeps its caps out past 700 m and is untouched.
    float highEye = smoothstep(60.0, 240.0, u_cameraPos.y);
    float capRange = 1.0 - smoothstep(mix(700.0, 300.0, highEye), mix(1800.0, 900.0, highEye), viewDist);
    // Only the STEEPEST crests break into whitecaps on a calm/moderate sea, so
    // open water reads as clear blue with sparse foam — not a dense grid of
    // whitecaps on every wave. Storms still lower the threshold for full coverage.
    float crest = pow(clamp(hn * (1.15 + 0.35 * stormSea) - (0.30 - 0.24 * stormSea), 0.0, 1.0), 3.4 - 1.6 * stormSea)
                * (0.5 + 0.5 * calm + u_stormIntensity * 0.4 + stormSea * 0.5) * stormFoamFade * capRange;
    vec2 foamUv = wp * 0.018 + u_time * vec2(0.012, 0.008);
    // …and a third octave, ROTATED off-axis and on a scale harmonic with
    // neither the swell nor the other two, so however the periods happen to line
    // up on a given heading their product does not repeat with any of them.
    mat2 foamRot = mat2(0.8253, -0.5647, 0.5647, 0.8253);
    float foamN2 = noise(foamRot * wp * 0.0413 - u_time * vec2(0.009, 0.014));
    float foamN = noise(foamUv * 3.0) * noise(foamUv * 7.0 + 1.5) * (0.62 + 0.76 * foamN2);
    // Break foam up harder (lower floor) so whitecaps are irregular, not a lattice.
    float breakup = mix(0.32, smoothstep(0.30 - 0.14 * stormSea, 0.66, foamN), breakupRange * 0.9 + 0.1);
    float foam = clamp(crest * breakup * 1.15, 0.0, 1.0);

    float shoreDetail = 1.0 - smoothstep(260.0, 900.0, viewDist);
    // The lap-film term below is one-sided in sd and so has no far edge of its
    // own; unfaded it drew a hard bright collar around every island footprint
    // out to the horizon. Surf is a metre-scale feature — past a couple of
    // hundred metres it is below a pixel and has no business being opaque.
    float shoreRange = 1.0 - smoothstep(110.0, 460.0, viewDist);
    float lap = sin(sd * 0.5 - u_time * 1.3) * 0.5 + 0.5;
    float lapNoise = noise(wp * 0.3 + u_time * vec2(0.05, -0.04));
    float shoreBand = (1.0 - smoothstep(2.0, 11.0, sd)) * smoothstep(0.5, 0.9, lap * (0.55 + 0.45 * lapNoise));
    float waterline = 1.0 - smoothstep(0.0, 2.2, sd);
    // Shore foam is a lapping FILM over lit sand, never an opaque plate. Both
    // ramps above are one-sided in sd, and sd measures the footprint
    // ELLIPSE — so every lagoon, bay and concave coast (the Castaway Reach
    // berth sits 15 m inside its island's ellipse) held them pinned at full
    // strength across acres of open water: a moored ship read as grounded on
    // snow and the atoll's reef slabs as pancakes floating on it. Capping what
    // the shore band may contribute keeps the surf line and gives the shelf
    // back its turquoise.
    float shoreFoam = min(max(shoreBand * (0.3 + 0.6 * shoreDetail), waterline * 0.55), 0.4) * shoreRange;
    foam = clamp(foam + shoreFoam, 0.0, 1.0);

    // Whitecaps are white PAINT, not a light source: they are as bright as what
    // falls on them. The old fixed 0.45 night mix left them glowing like lanterns
    // over a sea that had itself been dimmed to 0.42.
    vec3 foamCol = vec3(0.88, 0.93, 1.0) * lightScale
                 * mix(vec3(1.0), vec3(1.0, 0.82, 0.66), u_twilightFactor * 0.7);
    // …and what shore foam it does lay down is tinted toward the shallow water
    // it floats on rather than paper white, so a 30 cm shelf reads as bright
    // warm turquoise with the sand showing through it. Crest whitecaps out at
    // sea are untouched and keep the full white.
    vec3 shoreFilm = (shallowCol * 1.10 + vec3(0.12, 0.09, 0.04))
                   * lightScale
                   * mix(vec3(1.0), vec3(1.0, 0.82, 0.66), u_twilightFactor * 0.7);
    vec3 shoreFoamCol = mix(shoreFilm, foamCol, 0.22);
    float shoreShare = foam > 0.0001 ? clamp(shoreFoam / foam, 0.0, 1.0) : 0.0;
    vec3 color = mix(base, mix(foamCol, shoreFoamCol, shoreShare), foam);

    // ── Storm spray: wind-torn white haze over the wave tops, present even
    //    where the crest-foam noise breaks up ─────────────────────────────
    float spray = stormSea * smoothstep(0.20, 0.80, hn) * (0.40 + 0.60 * smoothstep(0.15, 0.50, foamN));
    color = mix(color, foamCol * 0.92, clamp(spray, 0.0, 1.0) * 0.55);

    // ── Subtle sub-surface scatter on lit wave flanks ───────────────────
    float sss = pow(max(0.0, dot(L, -N)), 3.0) * 0.14 * clamp(hn + 0.6, 0.0, 1.0);
    color += mix(vec3(0.05, 0.20, 0.26), vec3(0.24, 0.10, 0.20), sunPath * sunLow) * sss;

    // Calm, flat shallow water near shore was reflecting the overhead sun as a
    // broad white sheen — a blinding halo/lagoon plate. Damp the specular in the
    // shallows so tropical water keeps its turquoise instead of blowing out.
    color += specCol * (1.0 - shallowMask * 0.82);

    // THE MAGIC 0.42 NIGHT DIM IS GONE. It was the ocean's stand-in for a light
    // model: a single scalar, exempting foam from 40% of itself, that had to be
    // re-tuned by hand every time the scene's night key, ambient or hemisphere
    // moved — and it is why the sea sat 2.6x above the sky it reflects at
    // midnight (measured, balanced tier, pinned map). Night now arrives through
    // u_ambient / u_keyLight / skyTint, which are the same lights the deck under
    // the player's feet is shaded by.

    // Twilight: the sea takes the warm, dimmed cast of the sunset sky instead of
    // staying daytime cyan under a peach/indigo horizon.
    color = mix(color, color * vec3(1.12, 0.82, 0.68), u_twilightFactor * 0.6);
    color *= mix(1.0, 0.66, u_twilightFactor);

    // ── Lightning glint band: a strike lights the water it faces. Crest foam
    //    catches it hardest, plus a hard specular lobe from the bolt's own
    //    (steeply raked) direction, so the flash reads as a band racing across
    //    the swell toward the strike rather than a flat screen-wide brighten ──
    if (u_boltFlash > 0.001) {
      vec2 toPix = wp - u_cameraPos.xz;
      float toLen = max(1.0, length(toPix));
      float align = max(0.0, dot(toPix / toLen, u_boltDir));
      float band = pow(align, 3.0) * (0.30 + 0.70 * smoothstep(-0.1, 0.55, hn));
      vec3 boltL = normalize(vec3(u_boltDir.x, 0.55, u_boltDir.y));
      vec3 boltH = normalize(boltL + V);
      float boltSpec = pow(max(0.0, dot(N, boltH)), 90.0) * 1.4;
      color += vec3(0.60, 0.72, 1.00) * u_boltFlash
             * (band * (0.09 + foam * 0.90) + boltSpec * (0.25 + 0.75 * align));
    }

    // Storm: darker, desaturated water under gray skies
    vec3 stormTint = mix(vec3(1.0), vec3(0.42, 0.48, 0.55), u_stormIntensity);
    color *= stormTint;
    color = mix(color, color * vec3(0.72, 0.76, 0.82), u_stormIntensity * 0.55);

    // ── Aerial perspective + horizon dissolve: far water sinks into the
    //    fog color, then fully into the sky's horizon tint ───────────────
    float underwater = smoothstep(0.08, 1.8, u_underwaterDepth);
    float fogAmt     = (1.0 - exp(-viewDist * mix(0.00042, 0.0017, u_stormIntensity))) * (1.0 - underwater);
    // Started earlier and finished before the grid's own 3264 m rim so the last
    // ring is already pure sky by the time it runs out of geometry.
    float horizonAmt = smoothstep(900.0, 2900.0, viewDist) * (1.0 - underwater);
    // TWO STORM GREYS USED TO LIVE HERE, AND BOTH WERE DISPLAY-REFERRED NUMBERS
    // TREATED AS LINEAR. mix(u_fogColor, vec3(0.46,0.51,0.56), storm*0.8) is a
    // 0.71-sRGB grey mixed raw into water whose scene fog target (fogStormColor
    // 0x4a5764) is a 0.30-sRGB slate — five times darker; and
    // skyShape(mix(u_horizonColor, vec3(0.44,0.47,0.51), storm*0.85)) pushed a
    // second display number through the curve that expects LINEAR and landed on
    // 0.198 where the sky's own storm horizon shapes to 0.077. So in any storm
    // the last kilometre of sea dissolved to a plate ~2.6x the luminance of the
    // sky above it, with the islands standing in it fogging to the DARK scene
    // fog: the "bright sea, dark island, darker sky" read in r3-114.
    // Renderer.getAtmosphere already storm-blends BOTH inputs (fog toward
    // fogStormColor, horizon toward skyHorizonStormColor), so the ocean's job is
    // to use them, not to invent a third and a fourth storm grey of its own.
    vec3 fogCol     = u_fogColor;
    // The far dissolve target is the SKY, so it is shaped like the sky. Fed raw,
    // the horizon swatch landed ~1.7 stops hot through ACES and the last two
    // kilometres of sea became a flat white sheet with a hard edge on it.
    vec3 horizonCol = skyShape(u_horizonColor);
    color = mix(color, fogCol, fogAmt * 0.78);
    color = mix(color, horizonCol, horizonAmt);

    // From below, the ocean surface should read as a bright wavering ceiling instead
    // of disappearing due to back-face culling or using the above-water shader.
    if (underwater > 0.0) {
      float underside = step(u_cameraPos.y, v_worldPos.y + 0.05);
      float caustic = noise(v_worldPos.xz * 0.055 + u_time * vec2(0.05, -0.035));
      vec3 undersideColor = mix(vec3(0.02, 0.20, 0.31), vec3(0.20, 0.74, 0.86), fresnel * 0.72 + caustic * 0.12);
      undersideColor += vec3(0.05, 0.18, 0.22) * pow(max(0.0, dot(N, L)), 2.0);
      color = mix(color, mix(color, undersideColor, underside), underwater);
      color *= mix(vec3(1.0), vec3(0.48, 0.78, 0.9), underwater * (1.0 - underside) * 0.55);
    }

    gl_FragColor = vec4(color, 1.0);
    // A ShaderMaterial TONE-MAPS AND ENCODES ITSELF OR NOBODY DOES IT FOR IT.
    // three only injects these two chunks when the material renders to the
    // default framebuffer (WebGLPrograms: toneMapping/outputColorSpace are
    // per-material parameters only when the render target is null). On
    // balanced/high the scene goes through PostFx and OutputPass applies ACES +
    // sRGB to every pixel uniformly, so both includes expand to NOTHING and the
    // drawn frame is byte-identical to what it was before this line existed. On
    // the LOW tier there is no composer: renderer.render() writes straight to an
    // sRGB framebuffer with toneMapping=ACESFilmic set, the sky shader and every
    // MeshStandardMaterial encode themselves, and the ocean — 45-55% of the
    // frame — wrote raw linear. Measured at the sea/sky junction on the pinned
    // map, noon, low: sea 83 vs sky 125, a 0.66x step at the exact pixels that
    // are supposed to be the same colour.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Camera-centered concentric LOD grid. Hole extents are exact multiples of
// every level's cell size, and the whole grid snaps to the coarsest cell, so
// each level's vertices stay pinned to a fixed world lattice (no swimming)
// and level boundaries share vertex positions.
interface LodLevel { halfExtent: number; cell: number; hole: number }

/**
 * THE OUTER RING IS ALREADY FOG.
 *
 * Counted, not guessed: the three rings at 'high' are 73.7k + 69.1k + 78.6k =
 * 221.4k triangles, which the census confirms exactly on a settled frame — 20%
 * of an open-sea view and 11% of a wide island vista. And 78.6k of it, more than
 * a third, is the OUTER ring: water from 768 m to the grid's 3,264 m rim.
 *
 * That band does not get to show what it is made of. The fragment shader mixes
 * it into the fog colour on an exponential that is 28% closed at 768 m and 74%
 * at 2,900 m, and then into the SKY's own horizon tint on a smoothstep that is
 * complete at 2,900 m. What survives to the eye out there is a colour gradient;
 * the wave silhouette it is tessellated to carry is gone long before the
 * geometry runs out.
 *
 * So the outer ring's cell goes from 32 m to 48 m at 'high' (78,624 -> 34,944
 * triangles) and 64 m to 96 m at 'balanced' (19,656 -> 8,736), which takes the
 * whole grid from 221,472 to 177,792 and from 55,368 to 44,448. 'balanced' now
 * carries the same outer ring 'low' always had, and 'low' is untouched. The two
 * inner rings — the water you sail through and the water a cannonball crosses —
 * are untouched at every tier, which is where every wave anyone can resolve is.
 *
 * The constraint every level has to keep: hole extents are exact multiples of
 * each cell, and the whole grid snaps to the COARSEST cell, so each level's
 * vertices stay pinned to one world lattice and level boundaries share vertex
 * positions. 768/48 = 16, 6528/48 = 136, and 2 and 8 both divide 48; 768/96 = 8,
 * 6528/96 = 68, and 4 and 16 both divide 96. Break any of those and the sea
 * swims under the camera or cracks at a seam.
 */
const LOD_LEVELS: Record<RenderQuality, LodLevel[]> = {
  low: [ // 24,608 tris / 13,211 verts
    { halfExtent: 192, cell: 6, hole: 0 },
    { halfExtent: 768, cell: 24, hole: 192 },
    { halfExtent: 3264, cell: 96, hole: 768 },
  ],
  balanced: [ // 44,448 tris / 23,579 verts (was 55,368 / 29,427)
    { halfExtent: 192, cell: 4, hole: 0 },
    { halfExtent: 768, cell: 16, hole: 192 },
    { halfExtent: 3264, cell: 96, hole: 768 },
  ],
  high: [ // 177,792 tris / 93,267 verts (was 221,472 / 116,523)
    { halfExtent: 192, cell: 2, hole: 0 },
    { halfExtent: 768, cell: 8, hole: 192 },
    { halfExtent: 3264, cell: 48, hole: 768 },
  ],
};

function buildRingGeometry(level: LodLevel): THREE.BufferGeometry {
  const { halfExtent, cell, hole } = level;
  const n = Math.round((halfExtent * 2) / cell);
  const vertsPerRow = n + 1;
  const positions = new Float32Array(vertsPerRow * vertsPerRow * 3);
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const o = (iz * vertsPerRow + ix) * 3;
      positions[o] = -halfExtent + ix * cell;
      positions[o + 1] = 0;
      positions[o + 2] = -halfExtent + iz * cell;
    }
  }
  const indices: number[] = [];
  const holeLimit = hole - cell * 0.5 + 1e-6;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const cx = -halfExtent + (ix + 0.5) * cell;
      const cz = -halfExtent + (iz + 0.5) * cell;
      if (Math.abs(cx) < holeLimit && Math.abs(cz) < holeLimit) continue; // cell fully inside finer level
      const a = iz * vertsPerRow + ix;
      const b = a + 1;
      const c = a + vertsPerRow;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

interface OceanAtmosphere {
  fogColor?: THREE.Color;
  horizonColor?: THREE.Color;
  /** The ACTIVE light (sun by day, moon after dusk). */
  sunDir?: THREE.Vector3;
  /** The astronomical sun, for the sunset terms only. */
  sunDirTrue?: THREE.Vector3;
  keyColor?: THREE.Color;
  ambientColor?: THREE.Color;
  storminess?: number;
  nightFactor?: number;
  twilightFactor?: number;
  moonness?: number;
}

/** Island footprint for the shoreline SDF. Preferred: elliptical half-extents
 *  rx/rz in meters (radius × profile.footprintX/Z). Legacy circular `r` is
 *  still accepted and treated as rx = rz = r. */
interface OceanIslandFootprint {
  x: number;
  z: number;
  r?: number;
  rx?: number;
  rz?: number;
}

interface StormSeaState { centerX: number; centerZ: number; safeRadius: number; phase01: number }

export class OceanRenderer {
  private group!: THREE.Group;
  private material!: THREE.ShaderMaterial;
  private time = 0;
  private snapSize = 64;
  private pendingIslands: OceanIslandFootprint[] | null = null;
  private pendingStorm: StormSeaState | null = null;

  private readonly sunDir = new THREE.Vector3(0.62, 0.24, -0.74).normalize();

  init(scene: THREE.Scene, quality: RenderQuality = 'balanced') {
    const levels = LOD_LEVELS[quality];
    this.snapSize = levels[levels.length - 1].cell;

    this.material = new THREE.ShaderMaterial({
      vertexShader:   OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      // NAMED so a gate can find the linked program: three copies material.name
      // into WebGLProgram.name, and scripts/horizon-luminance-probe.mjs reads
      // gl.getShaderSource() off it to prove the two chunks above expand on low
      // and expand to nothing on balanced. An unnamed ShaderMaterial matched
      // three's own empty-named fullscreen quad and the gate graded the composer.
      name: 'ocean-surface',
      uniforms: {
        u_time:      { value: 0 },
        u_roughness: { value: getOceanRoughness(0) },
        u_sunDir:    { value: this.sunDir.clone() },
        u_cameraPos: { value: new THREE.Vector3() },
        u_stormIntensity: { value: 0 },
        u_underwaterDepth: { value: 0 },
        u_nightFactor: { value: 0 },
        u_twilightFactor: { value: 0 },
        // Defaults match the sky shader's daytime horizon haze / scene fog so
        // the sea-sky junction is seamless before live values get wired in.
        u_fogColor:     { value: new THREE.Color(0x9bbfd4) },
        u_horizonColor: { value: new THREE.Color(0.78, 0.90, 0.98) },
        // Defaults are the noon calibration: the values the old hand-tuned
        // `0.48 + diff * 0.62` used, so a frame drawn before the first
        // setAtmosphere() looks exactly as it did.
        u_keyLight:   { value: new THREE.Color(0.62, 0.62, 0.62) },
        u_ambient:    { value: new THREE.Color(0.48, 0.48, 0.48) },
        u_sunDirTrue: { value: this.sunDir.clone() },
        u_moonness:   { value: 0 },
        u_islands:     { value: Array.from({ length: MAX_ISLANDS }, () => new THREE.Vector4(0, 0, 1, 1)) },
        u_islandCount: { value: 0 },
        // Storm sea-state (shared getStormWaveIntensity inputs). Negative
        // safe radius = no storm, matching storm == null on the CPU side.
        u_stormCenter:     { value: new THREE.Vector2() },
        u_stormSafeRadius: { value: -1 },
        u_stormPhase01:    { value: 0 },
        // Lightning strike response (see setLightningFlash).
        u_boltFlash: { value: 0 },
        u_boltDir:   { value: new THREE.Vector2(0, 1) },
      },
      side: THREE.DoubleSide,
    });

    this.group = new THREE.Group();
    this.group.name = 'ocean-lod-grid';
    for (const level of levels) {
      const mesh = new THREE.Mesh(buildRingGeometry(level), this.material);
      mesh.frustumCulled = false; // always on screen; skips bad flat-geometry bounds vs displaced verts
      mesh.receiveShadow = false; // shadows on dynamic waves look odd
      this.group.add(mesh);
    }

    // Opaque deep-water sheet just under the surface: hides any sub-pixel
    // T-junction cracks at LOD seams. Front side only so it never occludes
    // the surface when the camera is underwater looking up. Sits below the
    // deepest storm trough (~-5.6m at storm=1) so it never pokes through.
    //
    // It is also the only thing a swimmer sees under the horizon, so its colour
    // is the seafloor read: near-black navy made every dive look like falling
    // into a hole. A murky teal (the same family as the underwater fog) reads as
    // deep water instead, and can never resolve to pure black.
    const underGeo = new THREE.PlaneGeometry(2400, 2400, 1, 1);
    underGeo.rotateX(-Math.PI / 2);
    const underlayer = new THREE.Mesh(
      underGeo,
      new THREE.MeshBasicMaterial({ color: 0x0b3c4c }),
    );
    underlayer.position.y = -6.5;
    this.group.add(underlayer);

    scene.add(this.group);

    if (this.pendingIslands) {
      this.setIslands(this.pendingIslands);
      this.pendingIslands = null;
    }
    if (this.pendingStorm) {
      const s = this.pendingStorm;
      this.pendingStorm = null;
      this.setStormState(s.centerX, s.centerZ, s.safeRadius, s.phase01);
    }
  }

  update(dt: number, cameraPos?: THREE.Vector3) {
    this.time += dt;
    this.material.uniforms.u_time.value = this.time;
    this.material.uniforms.u_roughness.value = getOceanRoughness(this.time);
    if (cameraPos) {
      (this.material.uniforms.u_cameraPos.value as THREE.Vector3).copy(cameraPos);
      const s = this.snapSize;
      this.group.position.set(Math.round(cameraPos.x / s) * s, 0, Math.round(cameraPos.z / s) * s);
    }
  }

  /** Hide the sea while the camera is under a cave roof. The ocean is one
   *  island-agnostic sheet with no holes punched for land, so wave crests
   *  (calm seas reach +1.6m, storms far more) render straight through the floor
   *  of any deep gallery — you stand in a lantern-lit cavern with the open sea
   *  lapping at your ankles. Underground there is never legitimately sea in
   *  frame, so the whole grid stands down. */
  setSuppressed(suppressed: boolean) {
    if (this.group) this.group.visible = !suppressed;
  }

  getTime() { return this.time; }

  /** Snap the wave clock to server time; update(dt) keeps extrapolating between syncs. */
  setWaveTime(tSeconds: number) {
    this.time = tSeconds;
    if (this.material) {
      this.material.uniforms.u_time.value = this.time;
      this.material.uniforms.u_roughness.value = getOceanRoughness(this.time);
    }
  }

  /** Feed island footprints for the shoreline SDF (foam band, shallows ramp,
   *  shore damping). Accepts elliptical {x, z, rx, rz} entries; legacy
   *  {x, z, r} circles still work (rx = rz = r). */
  setIslands(islands: OceanIslandFootprint[]) {
    if (!this.material) {
      this.pendingIslands = islands;
      return;
    }
    const arr = this.material.uniforms.u_islands.value as THREE.Vector4[];
    const count = Math.min(islands.length, MAX_ISLANDS);
    for (let i = 0; i < count; i++) {
      const isl = islands[i];
      const rx = Math.max(1, isl.rx ?? isl.r ?? 1);
      const rz = Math.max(1, isl.rz ?? isl.r ?? 1);
      arr[i].set(isl.x, isl.z, rx, rz);
    }
    this.material.uniforms.u_islandCount.value = count;
  }

  /** Drive the storm SEA STATE (wave geometry) from replicated storm data —
   *  mirrors shared getStormWaveIntensity(), so pass the same inputs gameplay
   *  physics uses: storm center, current safeRadius, and
   *  phase01 = clamp((storm.phase - 1) / 6, 0, 1). Pass a negative safeRadius
   *  (or call clearStormState) when there is no storm. This is separate from
   *  setStormIntensity, which only tints the water for local weather. */
  setStormState(centerX: number, centerZ: number, safeRadius: number, phase01: number) {
    if (!this.material) {
      this.pendingStorm = { centerX, centerZ, safeRadius, phase01 };
      return;
    }
    const u = this.material.uniforms;
    (u.u_stormCenter.value as THREE.Vector2).set(centerX, centerZ);
    u.u_stormSafeRadius.value = safeRadius;
    u.u_stormPhase01.value = Math.max(0, Math.min(1, phase01));
  }

  /** Return the sea to its calm (no-storm) state. */
  clearStormState() {
    this.setStormState(0, 0, -1, 0);
  }

  setAtmosphere(atmo: OceanAtmosphere) {
    if (!this.material) return;
    const u = this.material.uniforms;
    if (atmo.fogColor) (u.u_fogColor.value as THREE.Color).copy(atmo.fogColor);
    if (atmo.horizonColor) (u.u_horizonColor.value as THREE.Color).copy(atmo.horizonColor);
    if (atmo.sunDir) this.setSunDirection(atmo.sunDir);
    if (atmo.sunDirTrue) (u.u_sunDirTrue.value as THREE.Vector3).copy(atmo.sunDirTrue).normalize();
    if (atmo.keyColor) (u.u_keyLight.value as THREE.Color).copy(atmo.keyColor);
    if (atmo.ambientColor) (u.u_ambient.value as THREE.Color).copy(atmo.ambientColor);
    if (atmo.moonness !== undefined) u.u_moonness.value = Math.max(0, Math.min(1, atmo.moonness));
    if (atmo.storminess !== undefined) this.setStormIntensity(atmo.storminess);
    if (atmo.nightFactor !== undefined) {
      u.u_nightFactor.value = Math.max(0, Math.min(1, atmo.nightFactor));
    }
    if (atmo.twilightFactor !== undefined) {
      u.u_twilightFactor.value = Math.max(0, Math.min(1, atmo.twilightFactor));
    }
  }

  /** Local-weather storm COLOR intensity (darken/desaturate tint, wider spec
   *  lobe, denser fog). Wave GEOMETRY is driven by setStormState instead. */
  setStormIntensity(intensity: number) {
    const t = Math.max(0, Math.min(1, intensity));
    this.material.uniforms.u_stormIntensity.value = t;
  }

  /** Lightning response: `strength` is the strike's 0..1 brightness envelope,
   *  `dirX/dirZ` the (unnormalized) horizontal direction from the camera toward
   *  the bolt. Drives the glint band in the fragment shader. */
  setLightningFlash(strength: number, dirX: number, dirZ: number) {
    if (!this.material) return;
    this.material.uniforms.u_boltFlash.value = Math.max(0, Math.min(1, strength));
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) (this.material.uniforms.u_boltDir.value as THREE.Vector2).set(dirX / len, dirZ / len);
  }

  /** CPU mirror of the shader's stormWaveIntensity() using the LIVE uniforms —
   *  so callers (rain splashes) agree with the sea actually being drawn, which
   *  is not always the replicated storm (see ?stormdemo's parked ring). */
  getStormSeaIntensity(x: number, z: number): number {
    if (!this.material) return 0;
    const u = this.material.uniforms;
    const safeRadius = u.u_stormSafeRadius.value as number;
    if (safeRadius < -0.5) return 0;
    const center = u.u_stormCenter.value as THREE.Vector2;
    const phase01 = u.u_stormPhase01.value as number;
    const distOutside = Math.hypot(x - center.x, z - center.y) - safeRadius;
    // smoothstep(-140, 40, distOutside)
    const e = Math.max(0, Math.min(1, (distOutside + 140) / 180));
    const edge = e * e * (3 - 2 * e);
    const ambient = phase01 * 0.38;
    return Math.max(0, Math.min(1, Math.max(edge * (0.55 + phase01 * 0.45), ambient)));
  }

  /** Height of the drawn water surface at (x, z) — the same shared Gerstner
   *  field the vertex shader displaces to, evaluated against the live storm
   *  sea-state. Rain impacts land exactly on the visible swell. */
  getSurfaceY(x: number, z: number): number {
    return gerstnerHeight(x, z, this.time, WAVE_PARAMS, this.getStormSeaIntensity(x, z));
  }

  setSunDirection(direction: THREE.Vector3) {
    this.sunDir.copy(direction).normalize();
    (this.material.uniforms.u_sunDir.value as THREE.Vector3).copy(this.sunDir);
  }

  setUnderwaterDepth(depth: number) {
    this.material.uniforms.u_underwaterDepth.value = Math.max(0, depth);
  }
}
