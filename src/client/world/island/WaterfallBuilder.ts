/**
 * Waterfalls — the whole composition, not just the water.
 *
 * The old builder drew 2-3 flat white quads down whatever slope it could find.
 * With no island face steeper than ~0.75 drop/horiz, every fall on the map fell
 * back to draping a ribbon across a grass hillside: a white strip lying on
 * dirt, ending abruptly at a bare top edge, with no source, no rock and no
 * pool. This module builds the thing a stylized game actually ships:
 *
 *  LIP    a sculpted rock spillway standing proud of the crest, with a notch
 *         cut through it, and a SOURCE BASIN of pooled water behind it — so the
 *         water leaves rock over an overhang instead of appearing out of soil.
 *  BODY   one water PATH solved down the slope: at every rock shelf the water
 *         leaves the crest on a ballistic arc and falls until it meets the face
 *         again (`max(ballistic, faceReach)`), then rides the rock inside a
 *         carved trough until the next shelf. Where the slope is too shallow
 *         for a single plunge — which is every island here — the drop is broken
 *         into 2-4 CASCADE steps, each a real dammed pool + spill + plunge.
 *         Three layered sheets are swept along that path, offset in DEPTH (not
 *         just sideways) so the fall reads as translucent volume.
 *  BASE   a plunge pool with foam ringing out of the impact, drifting foam
 *         rafts, mist, and a runout stream that carries on to the sea.
 *
 * Everything here is seated on the DRAWN hillside (see `makeDrawnGround`), not
 * on the analytic heightfield it was sampled from — a triangle is a chord, and
 * the difference is what left the outflow lying clear of the grass.
 *
 * All motion is in the shaders, driven by the shared `foliageTime` clock: the
 * island subtree is frozen out of three's matrix walk (freezeStaticSubtree) and
 * nothing here writes a transform or a vertex after build.
 *
 * Budget: three draw calls per fall — one merged rock mesh (shelves, troughs,
 * bank boulders), one merged water mesh (every sheet, pool and runout share a
 * material and a geometry), one mist Points.
 */
import * as THREE from 'three';
import { getIslandSurfaceY } from '../../../shared/utils/index.js';
import { ZERO_SCALE_MAT4 } from '../../rendering/three-util.js';
import type { IslandBuildCtx } from './context.js';
import { ensureMeshGround } from './GroundTruth.js';

const GRAVITY = 9.81;
/** Base mesh for every rock the fall strews about.
 *
 * The shared decor `boulderGeo` is a subdivision-0 dodecahedron: twelve faces,
 * and once it is squashed on two axes it silhouettes as a grey CUBE — the
 * "angular shards / floating debris" the audit read around the column. One
 * subdivision of an icosahedron (80 faces) plus the per-vertex radial jitter
 * pushBoulder applies gives a genuinely broken-stone outline for 44 more
 * triangles, and it still merges into the fall's single rock draw call. */
const FALL_BOULDER_GEO = new THREE.IcosahedronGeometry(0.9, 1);
/** How far the sheet stands off the rock face once it lands back on it. */
const FACE_CLEARANCE = 0.34;
/** Water surface height above the terrain wherever the stream rides the rock;
 *  the trough walls fill the gap so nothing floats. */
const RIDE_LIFT = 0.36;

// ── the ground this fall is actually drawn against ────────────────────────

/**
 * Every height in this module used to come from `getIslandSurfaceY` — the
 * analytic heightfield. The hillside the player looks at is the polar TRIANGLE
 * MESH sampled from that field on a ~4 m grid, and a triangle is a chord: on
 * every convex form (a ridge, a shoulder, the lip of a plunge basin — i.e. the
 * exact places a watercourse is found) the drawn surface runs BELOW the
 * function it was sampled from.
 *
 * That is the whole close-range complaint. The sheet rides at `T(s) +
 * RIDE_LIFT`, so a chord sagging half a metre under the function leaves the
 * outflow hanging clear of the grass — "white ribbon fragments lying
 * disconnected on open grass like torn paper" — and every shelf, crag and bank
 * boulder seated through `groundAt` hangs the same distance off the cliff it is
 * supposed to be growing out of. It is the same defect GroundTruth was written
 * for; the falls were simply never moved onto it.
 *
 * So: one sampler, mesh-true wherever the terrain mesh covers the point and
 * analytic beyond its rim (off the footprint, and on the low-detail proxy path
 * where there is no indexed mesh at all).
 */
type DrawnGround = (localX: number, localZ: number) => number;

function makeDrawnGround(ctx: IslandBuildCtx): DrawnGround {
  const ground = ensureMeshGround(ctx);
  const { island } = ctx;
  const ox = island.position.x;
  const oz = island.position.z;
  return (lx: number, lz: number): number => {
    const y = ground?.heightAt(lx, lz);
    return y === null || y === undefined ? getIslandSurfaceY(island, lx + ox, lz + oz) : y;
  };
}

// ── the descent search ────────────────────────────────────────────────────

/** One sample along a heading: island-local x/z, terrain height, arc length. */
type RayPoint = { s: number; x: number; z: number; y: number };

type Course = {
  angle: number;
  dirX: number;
  dirZ: number;
  ray: RayPoint[];
  /** Index of the crest (start of the descent) and of the toe. */
  i0: number;
  i1: number;
  drop: number;
  run: number;
  grade: number;
};

/** Terrain profile along one heading, from just inside the peak to past the
 *  shoreline. Sampled through `surfacePoint` so the island's elliptical
 *  footprint is respected. */
function traceRay(ctx: IslandBuildCtx, angle: number, drawn: DrawnGround): RayPoint[] {
  const out: RayPoint[] = [];
  let s = 0;
  let px = 0;
  let pz = 0;
  for (let d = 0.03; d <= 1.06; d += 0.022) {
    const p = ctx.surfacePoint(d, angle);
    if (out.length > 0) s += Math.hypot(p.x - px, p.z - pz);
    // The profile the course is SOLVED on has to be the profile it is DRAWN
    // against, or the whole chain is authored a chord-sag off the hillside.
    out.push({ s, x: p.x, z: p.z, y: drawn(p.x, p.z) });
    px = p.x;
    pz = p.z;
  }
  return out;
}

/**
 * The best watercourse on this island near `nominal`.
 *
 * Scores every (crest, toe) window on every heading in a fan: a course is a
 * monotone-ish descent of at least 6m whose mean grade clears 0.3, scored by
 * drop weighted toward steepness, with a bonus for running all the way out to
 * the waterline (a fall that ends halfway down a hill has nowhere to go).
 */
function findCourse(ctx: IslandBuildCtx, nominal: number, avoid: number[], drawn: DrawnGround): Course | null {
  let best: Course | null = null;
  let bestScore = 0;
  for (let a = -13; a <= 13; a++) {
    const angle = nominal + a * 0.085;
    let tooClose = false;
    for (const other of avoid) {
      let delta = Math.abs(((angle - other + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      delta = Math.PI - delta;
      if (delta < 0.95) tooClose = true;
    }
    if (tooClose) continue;
    const ray = traceRay(ctx, angle, drawn);
    for (let i = 0; i < ray.length - 4; i++) {
      // The crest has to be high ground that is already falling away.
      if (ray[i].y < 7) continue;
      if (i > 0 && ray[i - 1].y < ray[i].y - 0.15) continue;
      let runningMin = ray[i].y;
      for (let j = i + 2; j < ray.length; j++) {
        // Stop at the foot of the next hill: past a 1.4m climb the course is
        // no longer one continuous descent.
        if (ray[j].y > runningMin + 1.4) break;
        runningMin = Math.min(runningMin, ray[j].y);
        // A fall has to END at the waterline, not under it: a toe sampled on
        // the drowned shelf put the plunge pool 4m below the sea.
        if (ray[j].y < 0.7) break;
        const drop = ray[i].y - ray[j].y;
        const run = ray[j].s - ray[i].s;
        if (drop < 6 || run < 3.5) continue;
        const grade = drop / run;
        if (grade < 0.3) continue;
        const score = drop * Math.pow(grade, 1.25) + (ray[j].y < 1.4 ? 5 : 0);
        if (score <= bestScore) continue;
        bestScore = score;
        const dx = ray[ray.length - 1].x - ray[0].x;
        const dz = ray[ray.length - 1].z - ray[0].z;
        const dl = Math.hypot(dx, dz) || 1;
        best = { angle, dirX: dx / dl, dirZ: dz / dl, ray, i0: i, i1: j, drop, run, grade };
      }
    }
  }
  return best;
}

// ── geometry sinks ────────────────────────────────────────────────────────

/** Position + colour + index accumulator for the merged rock mesh. */
class RockSink {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vert(x: number, y: number, z: number, c: THREE.Color): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    return i;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    return geo;
  }
}

/** Vertex sink for the water. Every sheet, pool and runout in one buffer.
 *  aFlowA = (u across [-1..1] or radial [0..1], metres travelled, aeration,
 *  kind 0=flowing/1=still); aFlowB = (metres from the impact, half width,
 *  alpha multiplier). */
class WaterSink {
  readonly pos: number[] = [];
  readonly fa: number[] = [];
  readonly fb: number[] = [];
  readonly idx: number[] = [];

  vert(
    x: number, y: number, z: number,
    u: number, vm: number, aer: number, kind: number,
    rim: number, halfW: number, alpha: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.fa.push(u, vm, aer, kind);
    this.fb.push(rim, halfW, alpha);
    return i;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('aFlowA', new THREE.Float32BufferAttribute(this.fa, 4));
    geo.setAttribute('aFlowB', new THREE.Float32BufferAttribute(this.fb, 3));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    return geo;
  }
}

// ── materials ─────────────────────────────────────────────────────────────

const WATER_NOISE_GLSL = `
float wfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wfNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wfHash(i), b = wfHash(i + vec2(1.0, 0.0));
  float c = wfHash(i + vec2(0.0, 1.0)), d = wfHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/**
 * The water surface: vertical flow noise stretched into foam streaks, a
 * wavering (noise-eaten) silhouette so no edge is ever a straight strip, ring
 * ripples spreading out of each impact on still water, fresnel rim lift, and
 * alpha that thickens with aeration. Standard material so it takes the sun, the
 * dusk swing and the scene's fog like everything else.
 */
function makeWaterMaterial(ctx: IslandBuildCtx, spraylight: SprayLight): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.25,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.name = 'waterfall-water';
  const time = ctx.host.foliageTime;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFallTime = time;
    shader.uniforms.uFallDeep = { value: new THREE.Color(0x1c6c7e) };
    shader.uniforms.uFallShallow = { value: new THREE.Color(0x74c8d4) };
    shader.uniforms.uFallFoam = { value: new THREE.Color(0xeff8fb) };
    shader.uniforms.uSprayLight = spraylight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'attribute vec4 aFlowA;\n'
        + 'attribute vec3 aFlowB;\n'
        + 'varying vec4 vFlowA;\n'
        + 'varying vec3 vFlowB;\n',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + 'vFlowA = aFlowA;\n'
        + 'vFlowB = aFlowB;\n',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'uniform float uFallTime;\n'
        + 'uniform vec3 uFallDeep;\n'
        + 'uniform vec3 uFallShallow;\n'
        + 'uniform vec3 uFallFoam;\n'
        + 'uniform vec3 uSprayLight;\n'
        + 'varying vec4 vFlowA;\n'
        + 'varying vec3 vFlowB;\n'
        + WATER_NOISE_GLSL,
      )
      // Injected here (not at <color_fragment>) because this is the first slot
      // where `normal` and `vViewPosition` exist — the fresnel needs both — and
      // diffuseColor / roughnessFactor are still read by the lighting below.
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n'
        + 'float wfT = uFallTime;\n'
        + 'float wfAer = vFlowA.z;\n'
        + 'vec2 wfQ = vec2(vFlowA.x * max(0.35, vFlowB.y), vFlowA.y);\n'
        // Three octaves squashed along the flow axis: long streaks, not blobs.
        + 'float wf1 = wfNoise(vec2(wfQ.x * 1.05, wfQ.y * 0.24 - wfT * 1.35));\n'
        + 'float wf2 = wfNoise(vec2(wfQ.x * 2.30 + 7.0, wfQ.y * 0.62 - wfT * 2.4));\n'
        + 'float wf3 = wfNoise(vec2(wfQ.x * 4.80 - 3.0, wfQ.y * 1.55 - wfT * 3.6));\n'
        + 'float wfStreak = wf1 * 0.46 + wf2 * 0.33 + wf3 * 0.21;\n'
        // A slow, very large-scale band gates the whitewater: without it the
        // whole sheet foams at once and reads as one solid white column.
        + 'float wfBand = wfNoise(vec2(wfQ.x * 0.30, wfQ.y * 0.14 - wfT * 0.55));\n'
        + 'float wfFlowFoam = smoothstep(0.44, 0.92, wfStreak + wfAer * 0.26 + wfBand * 0.20);\n'+ 'float wfRibs = 0.5 + 0.5 * sin(vFlowA.x * 6.5 + wf1 * 5.0 + wfQ.y * 0.35);\n'+ 'wfFlowFoam = clamp(wfFlowFoam * (0.55 + 0.75 * wfRibs), 0.0, 1.0);\n'
        // Still water: rings running out of the impact + slow drifting rafts.
        + 'float wfRing = 0.5 + 0.5 * sin(vFlowB.x * 2.7 - wfT * 1.9 + wf1 * 1.5);\n'
        + 'float wfRaft = wfNoise(vec2(wfQ.x * 0.80 + sin(wfT * 0.19) * 0.5, wfQ.y * 0.80 - wfT * 0.30));\n'
        + 'float wfPoolFoam = smoothstep(0.58, 0.94, wfRaft + wfAer * 0.30) * (0.45 + 0.55 * wfRing)\n'
        + '  + smoothstep(2.4, 0.25, vFlowB.x) * (0.30 + 0.40 * wfRing) * wfAer;\n'
        + 'float wfFoam = clamp(mix(wfFlowFoam, wfPoolFoam, vFlowA.w), 0.0, 1.0);\n'
        + 'vec3 wfBody = mix(uFallDeep, uFallShallow, clamp(0.10 + wfAer * 0.42 + wfStreak * 0.30, 0.0, 1.0));\n'
        + 'diffuseColor.rgb = mix(wfBody, uFallFoam, wfFoam);\n'
        // Silhouette: the lateral edge is eaten by scrolling noise, so the sheet
        // never draws the straight-sided strip the old ribbons did.
        + 'float wfEdgeN = wfNoise(vec2(vFlowA.y * 0.55 - wfT * 1.7, vFlowA.x * 1.7 + 4.0));\n'
        + 'float wfEdge = 1.0 - smoothstep(0.50 + wfEdgeN * 0.26, 1.0, abs(vFlowA.x));\n'
        + 'float wfA = (0.15 + 0.58 * wfFoam + 0.16 * wfAer) * wfEdge * vFlowB.z;\n'
        + 'float wfFres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);\n'
        + 'diffuseColor.a = clamp(wfA + wfFres * 0.18 * wfEdge * vFlowB.z, 0.0, 0.92);\n'
        + 'roughnessFactor = mix(0.06, 0.58, wfFoam);\n'
        // A whisper of self-light so whitewater still reads at dusk without
        // turning the fall into a lamp at midnight — and the whisper answers to
        // the sky, or midnight is exactly what it becomes.
        + 'totalEmissiveRadiance += uFallFoam * uSprayLight * wfFoam * 0.05;\n',
      );
  };
  mat.customProgramCacheKey = () => 'pirates-waterfall-water';
  return mat;
}

/**
 * The fall's SCULPTED ROCK — troughs, shelves, pool bowls, boulders.
 *
 * Two failures shared one material, and both photographed at Crow's Perch as
 * "untextured black boxes flanking the chute":
 *
 *  1. BLACK. The rock is `flatShading` + `DoubleSide`, and the trough/shelf
 *     strips are open SHEETS — half of them are wound away from wherever you
 *     happen to stand. three's flat-shaded path takes its normal from the
 *     screen-space derivatives of the view position and, unlike the smooth
 *     path, never multiplies it by `gl_FrontFacing`: on a back-facing triangle
 *     that normal points away from the eye, N·L goes negative for every light
 *     and the face renders as unlit black. (Proved live: forcing
 *     `flatShading = false` on the shipped mesh turned the same slabs mid-grey.
 *     Flipping the flat normal toward the eye keeps the faceted read AND the
 *     light.) Closed rock — every boulder here — is untouched: its front faces
 *     already point at the viewer, so the flip is a no-op.
 *  2. UNTEXTURED. Every other rock surface in the world grew a fragment-scale
 *     pass in an earlier wave (`paintCaveRock`, the sea-stack strata). The
 *     fall's rock never did, so a 4m shelf was one flat vertex-lerped tone —
 *     which is what makes it read as a BOX rather than as stone.
 */
function paintFallRock(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFallW;\n')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFallW = (modelMatrix * vec4(position, 1.0)).xyz;\n');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vFallW;\n' + WATER_NOISE_GLSL,
      )
      // Strata on the same ~2.4m pitch the terrain shader bands cliffs with, a
      // grain octave for the chisel marks, and a damp green-black in the
      // crevices — so a shelf beside the water reads as wet, layered stone.
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        + 'float fkWarp = wfNoise(vFallW.xz * 0.31);\n'
        + 'float fkBand = 0.5 + 0.5 * sin(vFallW.y * 2.35 + fkWarp * 5.0);\n'
        + 'float fkM1 = wfNoise(vFallW.xz * 0.62 + vFallW.y * 0.28);\n'
        + 'float fkM2 = wfNoise(vFallW.xz * 2.60 - vFallW.y * 0.85);\n'
        + 'float fkGrain = wfNoise(vFallW.xz * 9.5 + vFallW.y * 3.1);\n'
        + 'float fkShade = 0.70 + 0.26 * fkBand * (0.55 + 0.45 * fkM1) + 0.20 * fkM2 + 0.10 * fkGrain;\n'
        + 'diffuseColor.rgb *= clamp(fkShade, 0.45, 1.35);\n'
        // Mineral warmth in the dry bands, algal green in the damp shade.
        // Kept small on purpose: at full strength the tint turned the outcrops
        // beside a grey highland fall a distinct khaki, which is a different
        // wrong answer from the one this pass exists to fix.
        + 'diffuseColor.rgb += vec3(0.017, 0.011, 0.002) * smoothstep(0.62, 0.95, fkM2);\n'
        + 'diffuseColor.rgb += vec3(-0.007, 0.010, -0.004) * smoothstep(0.70, 0.30, fkBand) * (0.4 + 0.6 * fkM1);\n',
      )
      // `roughnessFactor` is only declared in this chunk — the wet sheen has to
      // be applied here, not up with the albedo.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n'
        + 'roughnessFactor = clamp(roughnessFactor - 0.22 * smoothstep(0.55, 0.95, fkM1), 0.35, 1.0);\n',
      )
      // The flat-normal flip. `vViewPosition` runs from the fragment TOWARD the
      // eye, so a normal disagreeing with it is a back face wearing an inverted
      // derivative normal — negate it and the sheet is lit from whichever side
      // you are standing on.
      .replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n'
        + '#ifdef FLAT_SHADED\n'
        + 'if (dot(normal, vViewPosition) < 0.0) { normal = -normal; nonPerturbedNormal = normal; }\n'
        + '#endif\n',
      );
  };
  mat.customProgramCacheKey = () => 'pirates-waterfall-rock';
}

/**
 * How lit the spray is, right now.
 *
 * PointsMaterial is UNLIT: the mist took no sun, no dusk swing and no night, so
 * at midnight the plunge pools wore a collar of daylight-white spray while
 * everything around them was moonlit blue — "night spray renders fullbright".
 * Sprites cannot be lit properly, but they can be told what the sky is doing,
 * so one shared colour (white by day, a cold moon-blue at night) multiplies the
 * mist and the foam's self-glow. One uniform object per island, updated on the
 * frame hook — the island subtree is frozen out of three's matrix walk, so this
 * is the only per-frame write the falls make.
 */
type SprayLight = { value: THREE.Color };

/** Full daylight → untouched; deep night → this. Not black: moonlight is real,
 *  and whitewater is the last thing on a hillside to stop being visible. */
const SPRAY_NIGHT_TINT = new THREE.Color(0.20, 0.26, 0.40);

/** Mist: soft sprites that rise, drift and fade on the shared clock. */
function makeMistMaterial(ctx: IslandBuildCtx, size: number, sprayLight: SprayLight): THREE.PointsMaterial {
  const mat = new THREE.PointsMaterial({
    size,
    map: ctx.host.getSoftParticleTexture(),
    color: 0xf4fbff,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
  });
  mat.name = 'waterfall-mist';
  const time = ctx.host.foliageTime;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFallTime = time;
    shader.uniforms.uSprayLight = sprayLight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'uniform float uFallTime;\n'
        + 'attribute vec4 aPuff;\n'   // phase, speed, rise, drift
        + 'varying float vPuff;\n',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
        + 'float pf = fract(aPuff.x + uFallTime * aPuff.y);\n'
        + 'transformed.y += pf * aPuff.z;\n'
        + 'transformed.x += sin(aPuff.x * 31.0 + pf * 3.1) * aPuff.w * pf;\n'
        + 'transformed.z += cos(aPuff.x * 17.0 + pf * 2.3) * aPuff.w * pf;\n'
        + 'vPuff = sin(pf * 3.14159);\n',
      )
      .replace('gl_PointSize = size;', 'gl_PointSize = size * (0.42 + pf * 1.3);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPuff;\nuniform vec3 uSprayLight;\n')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.a *= vPuff * vPuff;\ndiffuseColor.rgb *= uSprayLight;\n',
      );
  };
  mat.customProgramCacheKey = () => 'pirates-waterfall-mist';
  return mat;
}

// ── the fall itself ───────────────────────────────────────────────────────

/** One sample of the solved water path. */
type WPoint = {
  s: number;
  y: number;
  halfW: number;
  aer: number;
  alpha: number;
  /** Metres travelled along the whole path — the streak scroll coordinate. */
  vm: number;
  /** Metres since the last impact — where ripple rings come from. */
  rim: number;
  /** Riding the rock (gets a trough) as opposed to falling through air. */
  contact: boolean;
  /** Lateral offset of the centre line — a stream running dead straight down a
   *  hillside is the exact strip read this rebuild exists to kill. */
  lat: number;
};

type Pool = {
  s: number;
  y: number;
  rAlong: number;
  rAcross: number;
  aer: number;
  /** Arc position of the plunge that feeds it (ripple origin). */
  impactS: number;
};

type Dam = { s: number; crest: number; w: number; lip: boolean };

function buildFall(ctx: IslandBuildCtx, course: Course, fallIndex: number, mats: {
  water: THREE.MeshStandardMaterial;
  rock: THREE.MeshStandardMaterial;
  mist: THREE.PointsMaterial;
}, drawn: DrawnGround): THREE.Group | null {
  const { island, rng, lowDetail, islandSeed, cliffColor, paletteRock } = ctx;
  const seed = islandSeed * 977 + fallIndex * 613;
  const rnd = (k: number) => rng(seed + k * 37);

  const { ray, i0, i1, dirX, dirZ } = course;
  const ax = -dirZ;   // horizontal across-flow axis
  const az = dirX;
  const originX = ray[0].x;
  const originZ = ray[0].z;
  const sMin = ray[0].s;
  const sMax = ray[ray.length - 1].s;

  /** Terrain height at arc length s (linear between ray samples). */
  const T = (s: number): number => {
    const cs = THREE.MathUtils.clamp(s, sMin, sMax);
    const step = ray.length > 1 ? (ray[1].s - ray[0].s) : 1;
    const f = (cs - sMin) / step;
    const k = Math.min(ray.length - 2, Math.max(0, Math.floor(f)));
    const t = THREE.MathUtils.clamp(f - k, 0, 1);
    return ray[k].y * (1 - t) + ray[k + 1].y * t;
  };
  const px = (s: number) => originX + dirX * (s - sMin);
  const pz = (s: number) => originZ + dirZ * (s - sMin);
  /** Terrain height under an island-LOCAL point. Every rock vertex is seated
   *  with this, not with T(s): the profile only knows the centre line, and on a
   *  cone flank the ground 5m to the side is metres lower — seating the skirt
   *  off the centre line left the shelves hanging out of the hill as slabs.
   *  Mesh-true (see makeDrawnGround): the crags have to touch the cliff that is
   *  drawn, not the one the heightfield function describes. */
  const groundAt: DrawnGround = drawn;
  /** First arc position at or past `from` where the rock has fallen to `y`. */
  const faceS = (y: number, from: number): number => {
    for (let s = from; s <= sMax; s += 0.25) {
      if (T(s) <= y) {
        const prev = s - 0.25;
        const span = Math.max(1e-3, T(prev) - T(s));
        return prev + 0.25 * THREE.MathUtils.clamp((T(prev) - y) / span, 0, 1);
      }
    }
    return sMax;
  };

  /** Shrink a lateral half-extent until the ground at its edges is no more
   *  than `tol` below `level`. A pond or a channel wall wider than the hillside
   *  can carry turns into a flat plate cantilevered out of the slope — the
   *  single worst artefact of the first pass. */
  const fitLateral = (s: number, level: number, want: number, tol: number): number => {
    let r = want;
    for (let guard = 0; guard < 8 && r > 0.55; guard++) {
      const gl = groundAt(px(s) + ax * r, pz(s) + az * r);
      const gr = groundAt(px(s) - ax * r, pz(s) - az * r);
      if (level - Math.min(gl, gr) < tol) break;
      r *= 0.82;
    }
    return r;
  };

  const sCrest = ray[i0].s;
  const sToe = ray[i1].s;
  const drop = course.drop;
  const grade = course.grade;
  const yCrest = ray[i0].y;
  /** Half width of the watercourse — bigger falls carry more water. */
  const chanW = THREE.MathUtils.clamp(0.95 + drop * 0.055, 0.95, 2.6);

  // ── shelves ─────────────────────────────────────────────────────────────
  // The crest lip always exists: it is what gives the water an overhang to
  // leave from. Below it, shelves are spaced so that each pool's upstream end
  // lands exactly at the foot of the shelf above (spacing = thickness + h/grade
  // for a dam standing h proud of a slope of that grade), which is what makes a
  // shallow hillside read as a stepped cascade instead of a draped strip.
  const wLip = 1.5 + rnd(2) * 0.7;
  const dams: Dam[] = [{ s: sCrest, crest: yCrest + 0.85 + rnd(1) * 0.5, w: wLip, lip: true }];
  if (grade < 1.05) {
    const h = 0.95 + rnd(3) * 0.45;
    const spacing = wLip + h / Math.max(0.3, grade);
    const stepCount = THREE.MathUtils.clamp(Math.round(course.run / spacing) - 1, 1, 3);
    for (let k = 1; k <= stepCount; k++) {
      const sm = faceS(yCrest - (drop * k) / (stepCount + 1), sCrest + 2);
      if (sm >= sToe - 1.5 || sm <= dams[dams.length - 1].s + 2.2) continue;
      dams.push({ s: sm, crest: T(sm) + 0.7 + rnd(10 + k) * 0.5, w: 1.0 + rnd(20 + k) * 0.6, lip: false });
    }
  } else if (drop > 9) {
    // A sheer face gets ONE mid ledge to break the sheet; more would turn a
    // cliff fall into a staircase.
    const sm = faceS(yCrest - drop * (0.48 + rnd(4) * 0.14), sCrest + 2);
    if (sm > sCrest + 2.5 && sm < sToe - 2.5) {
      dams.push({ s: sm, crest: T(sm) + 0.55 + rnd(5) * 0.35, w: 0.9 + rnd(6) * 0.5, lip: false });
    }
  }

  // ── solve the water path ────────────────────────────────────────────────
  const sections: WPoint[][] = [];
  const pools: Pool[] = [];
  const impacts: { s: number; y: number; strength: number }[] = [];
  let vm = 0;
  let lastX = px(sCrest);
  let lastY = yCrest;
  let lastZ = pz(sCrest);
  let rimFrom = sCrest;
  const advance = (s: number, y: number) => {
    const x = px(s);
    const z = pz(s);
    vm += Math.hypot(x - lastX, y - lastY, z - lastZ);
    lastX = x;
    lastY = y;
    lastZ = z;
  };
  const meander = (s: number) => Math.sin(s * 0.21 + fallIndex * 2.3) * chanW * 0.5
    + Math.sin(s * 0.47 + 1.7) * chanW * 0.22;
  const point = (
    s: number, y: number, halfW: number, aer: number, contact: boolean, alpha = 1, lat = 0,
  ): WPoint => {
    advance(s, y);
    return { s, y, halfW, aer, alpha, vm, rim: Math.abs(s - rimFrom), contact, lat };
  };

  const baseLevel = () => T(sToe) + RIDE_LIFT;

  for (let m = 0; m < dams.length; m++) {
    const dam = dams[m];
    const level = dam.crest - 0.12;
    // Pool held behind this shelf: it reaches back up the hill to where the
    // ground rises through the water line (capped so a flat crest doesn't grow
    // a lake).
    let back = dam.s - 0.8;
    for (let s = dam.s; s >= dam.s - (dam.lip ? 7 : 5); s -= 0.3) {
      back = s;
      if (T(s) >= level - 0.05) break;
    }
    const poolLen = Math.max(1.1, dam.s - back);
    pools.push({
      s: dam.s - poolLen * 0.5,
      y: level,
      rAlong: poolLen * 0.5 + 0.35,
      rAcross: fitLateral(dam.s - poolLen * 0.5, level, chanW * (dam.lip ? 1.7 : 1.25), 1.6),
      aer: m === 0 ? 0.12 : 0.5,
      impactS: back,
    });

    // Spill: water crossing the shelf top through the notch, thinning as it
    // goes over the edge.
    const spill: WPoint[] = [];
    rimFrom = dam.s - poolLen;
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      const s = dam.s - 0.5 + (dam.w + 0.5) * t;
      const y = level - 0.06 * t - 0.18 * t * t;
      spill.push(point(s, y, chanW * (0.88 - 0.20 * t), 0.30 + 0.22 * t, true));
    }

    // Plunge: leave the lip on an arc, fall until the rock comes back up to
    // meet the water — `max` of the ballistic path and the face reach.
    const landY = m + 1 < dams.length ? dams[m + 1].crest - 0.12 : baseLevel();
    const fallH = Math.max(0.6, (level - 0.24) - landY);
    const exitV = 1.15 + 0.42 * Math.sqrt(fallH);
    const sLeave = dam.s + dam.w;
    const steps = Math.max(4, Math.min(30, Math.round(fallH / 0.45)));
    const plunge: WPoint[] = [];
    let landS = sLeave;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const dy = fallH * t;
      const y = level - 0.24 - dy;
      const sBal = sLeave + exitV * Math.sqrt((2 * dy) / GRAVITY);
      const sFace = faceS(y, sLeave) + FACE_CLEARANCE;
      // Capped advance: where the profile drops off a step, faceS jumps metres
      // downhill in one sample and an uncapped sheet stretches into a fragment
      // hanging in open air (verification, pass 3). Water that ends up briefly
      // inside the hill is hidden by it; water in mid-air is not.
      const s = Math.min(Math.max(sBal, Math.min(sFace, sMax)), sMax, landS + 1.4);
      const contact = sFace <= sBal + 0.05;
      // Aeration climbs as the sheet breaks up on the way down, and spikes at
      // the impact.
      // Aeration starts where the spill left off (0.52) rather than snapping
      // back to 0.16 — that discontinuity was the visible brightness step at the
      // lip, and the sheet is a single welded strip now, so it shows.
      const aer = THREE.MathUtils.clamp(0.50 + t * t * 0.40 + (t > 0.86 ? 0.1 : 0), 0, 1);
      const wob = 1 + Math.sin(t * 9.5 + fallIndex * 2.1) * 0.045;
      plunge.push(point(s, y, chanW * (0.68 + 0.34 * t) * wob, aer, contact));
      landS = s;
    }
    sections.push(spill.concat(plunge));
    impacts.push({ s: landS, y: landY, strength: THREE.MathUtils.clamp(fallH / 8, 0.35, 1) });
    rimFrom = landS;

    // Chute: if the next pool starts further downhill, the stream runs there
    // over the rock.
    if (m + 1 < dams.length) {
      const next = dams[m + 1];
      let backNext = next.s;
      for (let s = next.s; s >= next.s - 5; s -= 0.3) {
        backNext = s;
        if (T(s) >= next.crest - 0.17) break;
      }
      if (backNext > landS + 0.7) {
        const chute: WPoint[] = [];
        for (let s = landS; s <= backNext; s += 0.85) {
          chute.push(point(s, T(s) + RIDE_LIFT, chanW * 0.98, 0.58, true, 1, meander(s) * 0.5));
        }
        chute.push(point(backNext, T(backNext) + RIDE_LIFT, chanW * 0.98, 0.58, true, 1, meander(backNext) * 0.5));
        sections.push(chute);
      }
    }
  }

  // ── base pool + runout to the waterline ────────────────────────────────
  const impact = impacts[impacts.length - 1];
  const baseY = impact.y;
  const basePool: Pool = {
    s: impact.s + chanW * 0.9,
    y: baseY,
    rAlong: Math.min(chanW * 1.6, Math.max(1.2, (T(impact.s) - T(impact.s + chanW * 3)) > 2.2 ? chanW * 0.9 : chanW * 1.6)),
    rAcross: fitLateral(impact.s + chanW * 0.9, baseY, chanW * 1.9, 1.6),
    // Deliberately NOT full aeration: at 0.85 the shader foamed the entire disc
    // and the pool photographed as an opaque white paper cutout lying on the
    // grass. The whitewater belongs to the froth ring at the impact; the pond
    // itself should read as still, deep, blue-green water.
    aer: 0.55,
    impactS: impact.s,
  };
  pools.push(basePool);

  // Outflow: solved the same way the plunges are, so a pool perched on a sea
  // cliff pours OVER it instead of trying to lie flat down a vertical face.
  const runout: WPoint[] = [];
  rimFrom = impact.s;
  {
    const startS = basePool.s + basePool.rAlong * 0.7;
    // Water leaves a pool AT THE POOL'S SURFACE. Starting the outflow on the
    // GROUND under the rim instead dropped it by however far the hillside had
    // already fallen away — on a sea cliff that is metres, and the runout then
    // rendered as an isolated white shard hanging in air below the fall (the
    // artefact on 4 of the map's 6 falls; measured gaps 1.4-8.3 m).
    const startY = Math.max(0.6, baseY - 0.05);
    const reachesSea = T(Math.min(sMax, startS + 26)) < 1.1;
    // Into the sea: carry the sheet just under the waterline so the ocean takes
    // it, rather than fading it out in mid-air over the shallows.
    const endY = reachesSea ? 0.15 : Math.max(0.95, T(Math.min(sMax, startS + 26)));
    const fallH = Math.max(0.4, startY - endY);
    const steps = Math.max(4, Math.min(26, Math.round(fallH / 0.6)));
    const exitV = 1.0 + 0.3 * Math.sqrt(fallH);
    const sShore = faceS(0.85, startS);
    let prevS = startS;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const y = startY - fallH * t;
      const sBal = startS + exitV * Math.sqrt((2 * fallH * t) / GRAVITY);
      const sFace = faceS(y - RIDE_LIFT * 0.8, startS) + FACE_CLEARANCE;
      // Track the face while there IS a face — but below the waterline the
      // "face" is the submerged shelf, which keeps sloping away for tens of
      // metres, and chasing it walked the sheet out over open sea as a hose.
      // At the surface the ocean takes the water, so the sheet holds station.
      const above = y > 1.0;
      const chase = above ? Math.min(sFace, sMax) : prevS;
      // …and even against a real wall it never stands more than a metre clear:
      // off a sea cliff the ballistic term keeps advancing while the face does
      // not, and the outflow arced off the plinth into open air.
      const s = Math.min(
        Math.max(sBal, chase),
        sMax, prevS + 1.4, above ? sFace + 1.0 : prevS + 0.4, reachesSea ? sMax : sShore,
      );
      prevS = s;
      if (s > startS + 26) break;
      const contact = sFace <= sBal + 0.05;
      // Narrows and fades out over the last third rather than ending on a cut.
      const fade = reachesSea || t < 0.68 ? 1 : Math.max(0, 1 - ((t - 0.68) / 0.32) ** 2);
      runout.push(point(s, y, chanW * (0.62 - 0.30 * t), contact ? 0.4 : 0.6, contact, fade, meander(s)));
    }
  }
  if (runout.length > 1) sections.push(runout);

  // ── the chain has to be CONTINUOUS ──────────────────────────────────────
  // Spill, plunge, chute and runout are each solved on their own terms, and
  // any disagreement between where one ends and the next begins renders as a
  // hole with a detached white fragment under it. Two rules close that:
  //   · every section starts EXACTLY where the previous one ended (the shared
  //     cross-section is repeated, and any remaining distance is bridged with
  //     real points rather than left as a jump);
  //   · the chain ENDS on something — rock, or under the waterline. A tail
  //     still hanging in air is walked down until it meets one of them.
  for (let m = 1; m < sections.length; m++) {
    const prev = sections[m - 1];
    const next = sections[m];
    const head = prev[prev.length - 1];
    const start = next[0];
    const gap = Math.hypot(start.s - head.s, start.y - head.y, start.lat - head.lat);
    // Only ever bridge DOWNSTREAM and DOWNHILL: a link that ran backwards or
    // uphill would fold the swept strip on itself.
    if (gap <= 0.35 || start.s < head.s - 0.05 || start.y > head.y + 0.05) continue;
    const steps = Math.min(30, Math.max(1, Math.ceil(gap / 0.7)));
    const bridge: WPoint[] = [head];
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const s = head.s + (start.s - head.s) * t;
      const y = head.y + (start.y - head.y) * t;
      bridge.push({
        s,
        y,
        halfW: head.halfW + (start.halfW - head.halfW) * t,
        aer: Math.max(head.aer, start.aer),
        alpha: Math.min(head.alpha, start.alpha),
        vm: head.vm + (start.vm - head.vm) * t,
        rim: start.rim,
        // Riding rock only where the bridge genuinely hugs it; over a cliff the
        // link is a free plunge and must not grow a trough hanging in air.
        contact: y - T(s) < RIDE_LIFT + 0.6,
        lat: head.lat + (start.lat - head.lat) * t,
      });
    }
    next.unshift(...bridge);
  }
  // Only the OUTFLOW may be walked down like this: every other section ends in
  // a pool, which is its anchor, and dragging one of those to the ground would
  // pull the sheet straight through the pool it feeds.
  if (runout.length > 1) {
    const tail = sections[sections.length - 1];
    let p = tail[tail.length - 1];
    for (let guard = 0; guard < 40; guard++) {
      // Anchored once the sheet is riding the rock again, or once it is under
      // the waterline and the ocean takes it.
      if (p.y <= Math.max(T(p.s) + RIDE_LIFT + 0.4, 0.3)) break;
      const y = p.y - 0.62;
      // Follows the wall down rather than walking out from it on a fixed slope:
      // on the coastal plinth the face stands at one arc position for its whole
      // height, so this drops the tail vertically into the sea.
      const s = THREE.MathUtils.clamp(faceS(y, sCrest) + FACE_CLEARANCE, p.s, Math.min(sMax, p.s + 0.3));
      p = {
        s,
        y,
        halfW: p.halfW * 0.96,
        aer: Math.min(1, p.aer + 0.05),
        alpha: p.alpha,
        vm: p.vm + 0.69,
        rim: p.rim + 0.69,
        contact: false,
        lat: p.lat,
      };
      tail.push(p);
      if (s >= sMax - 1e-3) break;
    }
  }

  // ── weld the chain into ONE strip ───────────────────────────────────────
  // Spill, plunge, chute and runout were swept as SEPARATE strips sharing only
  // a bridged endpoint. Every joint therefore showed both a width jog (each
  // section authored its own halfW) and a brightness step (each authored its own
  // aeration), and the two strips' lane-depth normals disagreed across the seam:
  // the "ribbon segments misaligned mid-fall" read. One welded polyline, swept
  // once per lane with a single scrolling UV (`vm` is already cumulative over
  // the whole descent), cannot show a seam — there isn't one.
  const path: WPoint[] = [];
  for (const section of sections) {
    for (const p of section) {
      const prev = path[path.length - 1];
      if (prev) {
        // The chain only ever runs downstream and downhill. A section that opens
        // slightly behind/above the one before it (the next dam's spill starts
        // at its crest, which sits ~0.3m above the chute that fed it) would fold
        // the swept strip back on itself.
        p.s = Math.max(p.s, prev.s);
        p.y = Math.min(p.y, prev.y);
        p.vm = Math.max(p.vm, prev.vm);
        if (p.s - prev.s < 0.04 && prev.y - p.y < 0.04) continue;   // coincident
      }
      path.push(p);
    }
  }
  // Low-pass the width and the aeration along the welded path: what is left of
  // the old per-section steps dissolves over a couple of metres, which is what
  // turns the chain into one continuously tapered sheet.
  if (path.length > 2) {
    for (let pass = 0; pass < 3; pass++) {
      const hw = path.map((p) => p.halfW);
      const ae = path.map((p) => p.aer);
      for (let i = 0; i < path.length; i++) {
        let sw = 0; let sa = 0; let wsum = 0;
        for (let k = -2; k <= 2; k++) {
          const j = THREE.MathUtils.clamp(i + k, 0, path.length - 1);
          const wk = 1 / (1 + Math.abs(k));
          sw += hw[j] * wk;
          sa += ae[j] * wk;
          wsum += wk;
        }
        path[i].halfW = sw / wsum;
        path[i].aer = sa / wsum;
      }
    }
  }

  // ── sweep the sheet ─────────────────────────────────────────────────────
  const water = new WaterSink();
  const lanes = lowDetail
    ? [{ lat: 0, wide: 1, depth: 0, aer: 0, phase: 0 }, { lat: -0.2, wide: 0.6, depth: 0.14, aer: 0.2, phase: 3.7 }]
    : [
      { lat: 0, wide: 1, depth: 0, aer: 0, phase: 0 },
      { lat: -0.22, wide: 0.62, depth: 0.14, aer: 0.18, phase: 3.7 },
      { lat: 0.26, wide: 0.48, depth: 0.26, aer: 0.3, phase: 8.1 },
    ];
  const tan = new THREE.Vector3();
  const across = new THREE.Vector3(ax, 0, az);
  const nrm = new THREE.Vector3();
  if (path.length >= 2) {
    for (const lane of lanes) {
      let prevA = -1;
      let prevB = -1;
      for (let k = 0; k < path.length; k++) {
        const p = path[k];
        const q = path[Math.min(path.length - 1, k + 1)];
        const r = path[Math.max(0, k - 1)];
        tan.set(dirX * (q.s - r.s), q.y - r.y, dirZ * (q.s - r.s));
        if (tan.lengthSq() < 1e-6) tan.set(dirX, 0, dirZ);
        tan.normalize();
        nrm.copy(across).cross(tan).normalize();
        const cx = px(p.s) + ax * (p.lat + lane.lat * p.halfW) + nrm.x * lane.depth;
        const cy = p.y + nrm.y * lane.depth;
        const cz = pz(p.s) + az * (p.lat + lane.lat * p.halfW) + nrm.z * lane.depth;
        const hw = p.halfW * lane.wide;
        const aer = Math.min(1, p.aer + lane.aer);
        const vmk = p.vm + lane.phase;
        const a = water.vert(cx + ax * hw, cy, cz + az * hw, 1, vmk, aer, 0, p.rim, hw, p.alpha);
        const b = water.vert(cx - ax * hw, cy, cz - az * hw, -1, vmk, aer, 0, p.rim, hw, p.alpha);
        if (prevA >= 0) water.quad(prevA, a, b, prevB);
        prevA = a;
        prevB = b;
      }
    }
  }

  // ── pools ───────────────────────────────────────────────────────────────
  /** Sweep one ring of the pool disc. `u` is the shader's silhouette
   *  coordinate: at |u| = 1 the noise-eaten edge dissolves the surface
   *  completely, which is right for the LATERAL edge of a falling sheet and
   *  quite wrong for a pond — it made every plunge pool fade to nothing before
   *  its rim, so the fall visibly ended on bare grass. Rings inside the pool
   *  carry a low u and only the outermost one fades. */
  const poolRing = (
    pool: Pool, radius: number, u: number, aer: number, alpha: number, segs: number,
  ): number[] => {
    const cx = px(pool.s);
    const cz = pz(pool.s);
    const out: number[] = [];
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2;
      const wob = 0.88 + 0.16 * Math.sin(th * 3 + fallIndex) + 0.08 * Math.sin(th * 5 + 1.3);
      const along = Math.cos(th) * pool.rAlong * radius * wob;
      const side = Math.sin(th) * pool.rAcross * radius * wob;
      const vx = cx + dirX * along + ax * side;
      const vz = cz + dirZ * along + az * side;
      // Pools sit ON the rock; drop the rim to the ground where the ground is
      // already lower, so no pool lip ever hangs in the air.
      const gy = groundAt(vx, vz);
      // A DEAD-flat disc is what read as a "flat white splash sheet" pasted
      // across the chute: every vertex shared one normal, so the whole pond took
      // one lighting value and the shader's fresnel never moved. A few
      // centimetres of swell (deterministic, so the pool is stable) is enough
      // for the surface to catch the sun unevenly and read as water.
      const swell = (Math.sin(th * 4 + fallIndex * 2.3) * 0.6 + Math.sin(th * 7 - 1.1) * 0.4) * 0.055 * radius;
      const vy = Math.max(pool.y - 0.5, Math.min(pool.y, gy + 0.9)) + swell;
      const rim = Math.hypot(pool.s + along - pool.impactS, side);
      out.push(water.vert(vx, vy, vz, u, (pool.s + along) - pool.impactS, aer, 1, rim, pool.rAcross, alpha));
    }
    return out;
  };
  for (const pool of pools) {
    const segs = lowDetail ? 14 : 22;
    const cx = px(pool.s);
    const cz = pz(pool.s);
    const centre = water.vert(cx, pool.y, cz, 0, pool.s - pool.impactS, pool.aer, 1,
      Math.abs(pool.s - pool.impactS), pool.rAcross, 1);
    // Three rings: a solid body, a foam-charged collar and a soft dissolving
    // lip. The foam ring is what reads as "the water hit something here".
    const body = poolRing(pool, 0.62, 0.18, pool.aer, 1, segs);
    const collar = poolRing(pool, 0.90, 0.46, Math.min(1, pool.aer + 0.15), 1, segs);
    const lip = poolRing(pool, 1.0, 0.94, Math.min(1, pool.aer + 0.25), 1, segs);
    for (let k = 0; k < segs; k++) {
      water.tri(centre, body[k], body[k + 1]);
      water.quad(body[k], collar[k], collar[k + 1], body[k + 1]);
      water.quad(collar[k], lip[k], lip[k + 1], collar[k + 1]);
    }
  }

  // ── the impact: a froth ring blowing out of the plunge ──────────────────
  // The base of the fall had nothing but the pool disc under it. A low
  // annulus of maximally-aerated still water, sitting a hand's width above the
  // pool and centred on the impact rather than the pond, gives the collision a
  // white boil with the shader's ripple rings running out of it.
  {
    const segs = lowDetail ? 14 : 26;
    const cxI = px(impact.s);
    const czI = pz(impact.s);
    const outer = chanW * (lowDetail ? 1.4 : 1.75);
    // Three concentric rings, u climbing to 1 at the lip so the shader's
    // noise-eaten silhouette dissolves the outside edge. A two-ring version with
    // a hard 0.85 lip and a ±0.32 radial wobble drew a white ORIGAMI STAR
    // sitting on the grass (verification pass 3).
    const bands = [
      { r: 0.34, u: 0.10, aer: 1.0, rim: 0.15 },
      { r: 0.70, u: 0.44, aer: 1.0, rim: 0.9 },
      { r: 1.00, u: 1.00, aer: 0.85, rim: 2.0 },
    ];
    let prev: number[] | null = null;
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2;
      const wob = 0.94 + 0.07 * Math.sin(th * 3 + fallIndex * 1.7) + 0.04 * Math.sin(th * 7 + 2.1);
      const co = Math.cos(th);
      const si = Math.sin(th);
      const cols = bands.map((band) => {
        const r = outer * band.r * wob;
        const vx = cxI + dirX * co * r + ax * si * r;
        const vz = czI + dirZ * co * r + az * si * r;
        // THE FLAT WHITE SPLASH SHEET. Every vertex of this annulus used to
        // take one height, so the boil was a dead-level white disc laid across
        // the slope — seen from the side (which is how you meet a mid-fall step)
        // it presented a straight bright EDGE cutting across the chute, and the
        // shader's fresnel, having one normal to work with, never moved on it.
        // Water landing on rock does the opposite of level: it heaps over the
        // plunge and spills away at the rim. So: a crown that falls off with
        // radius, plus a deterministic swell (same phase family as the pool's,
        // so a fall's boil and its pond breathe together) — enough tilt that
        // every facet catches the sun differently and the disc reads as churn.
        const crown = (1 - band.r) * 0.22;
        const swell = (Math.sin(th * 3 + fallIndex * 2.1) * 0.6 + Math.sin(th * 5 - 1.4) * 0.4)
          * 0.055 * outer * (0.35 + band.r);
        // Clamped AFTER the swell, not before: the boil may never climb off its
        // own ground, which is the invariant the flat version bought its
        // flatness with.
        const vy = Math.min(baseY + 0.12 + crown + swell, groundAt(vx, vz) + 0.75);
        // aFlowB.x is "metres from the impact", and the shader turns anything
        // under 2.4 into whitewater: normalise the ring onto that scale so a
        // big fall's wide boil is as white as a small one's.
        return water.vert(vx, vy, vz, band.u, th * 2.2 + r, band.aer, 1, band.rim, outer, 1);
      });
      if (prev) for (let c = 0; c < cols.length - 1; c++) water.quad(prev[c], cols[c], cols[c + 1], prev[c + 1]);
      prev = cols;
    }
  }

  // ── rock: shelves, the trough the stream runs in, bank boulders ─────────
  const rock = new RockSink();
  const wetRock = paletteRock.clone().multiplyScalar(0.72).lerp(new THREE.Color(0x3f5f66), 0.30);
  // Pulled back from ×1.04: at full cliff brightness every shelf and bank stone
  // read as a pale chip against the island's olive flank, which is half of why
  // they photographed as debris rather than as the hillside's own rock.
  const dryRock = cliffColor.clone().multiplyScalar(0.84);
  const rockColor = (y: number, waterY: number, jitter: number): THREE.Color => {
    // Strata banding on the same ~2.5m pitch the terrain shader uses, so these
    // outcrops read as the island's own stone…
    const band = 0.88 + 0.12 * Math.sin(y * 2.35 + jitter * 3.1);
    // …and the wet darkening is a BAND at the waterline. Darkening everything
    // below the crest turned every shelf into a black plate on a tan hillside.
    const wet = THREE.MathUtils.clamp(1 - Math.abs(y - waterY) / 1.4, 0, 1);
    return dryRock.clone().lerp(wetRock, wet * 0.85).multiplyScalar(band * (0.9 + jitter * 0.2));
  };

  /** A shelf: a notched rock spillway standing proud of the hillside, its
   *  skirt undercut at the waist so the front face genuinely overhangs. */
  const pushShelf = (dam: Dam, index: number) => {
    // Fitted to the hillside as well: a shelf wider than the ground can carry
    // silhouettes as a broken plate sticking out of a ridge.
    const halfW = fitLateral(dam.s, dam.crest, chanW * (dam.lip ? 1.5 : 1.3) + 0.5, 1.4);
    const back = dam.s - (1.0 + chanW * 0.5);
    const front = dam.s + dam.w;
    // Six rows across the spillway rather than four: at nA=4 the shelf top was
    // a handful of big quads, and a big quad on a hillside is a PLATE.
    const nA = 6;
    const nX = 7;
    const top: number[][] = [];
    for (let ia = 0; ia <= nA; ia++) {
      const ta = ia / nA;
      const s = back + (front - back) * ta;
      const row: number[] = [];
      for (let ix = 0; ix <= nX; ix++) {
        const tx = ix / nX;
        const xf = (tx - 0.5) * 2;
        const j = rng(seed + index * 131 + ia * 17 + ix * 5);
        // Notch: the middle of the shelf is cut down below the water line so
        // the fall pours THROUGH the rock rather than over a flat table.
        const notch = 1 - THREE.MathUtils.smoothstep(Math.abs(xf), 0.30, 0.62);
        // Deeper per-vertex roughness on the shoulders: a smooth ramp of them
        // silhouettes as one flat table, and a table beside a waterfall reads as
        // debris rather than as the rock the water pours over.
        const shoulder = 0.20 + j * 0.72 + Math.abs(xf) * 0.34
          + Math.sin(ia * 2.1 + ix * 1.7 + index) * 0.16;
        const y = dam.crest + shoulder * (1 - notch) - 0.34 * notch;
        // The downstream edge is pushed out past its own footprint: that
        // overhang is what stops the sheet reading as a strip draped on soil.
        const jut = ta * ta * (0.35 + j * 0.25);
        const sx = s + jut;
        const vx = px(sx) + ax * xf * halfW * (0.94 + j * 0.12);
        const vz = pz(sx) + az * xf * halfW * (0.94 + j * 0.12);
        // Outboard of the channel the shelf sinks back into the hillside
        // instead of cantilevering over it as a slab. It used to stop 0.45-0.8m
        // ABOVE its own ground, which on a cone flank is a grey plate hovering
        // over the grass — the "floating debris" the fall was ringed with.
        // Outboard now finishes BELOW the ground and the eye only ever sees the
        // spillway itself.
        const g = groundAt(vx, vz);
        const outboard = THREE.MathUtils.smoothstep(Math.abs(xf), 0.30, 0.86);
        const vy = THREE.MathUtils.lerp(y, Math.min(y, g - 0.12 - j * 0.22), outboard);
        row.push(rock.vert(vx, vy, vz, rockColor(vy, dam.crest, j)));
      }
      top.push(row);
    }
    for (let ia = 0; ia < nA; ia++) {
      for (let ix = 0; ix < nX; ix++) {
        rock.quad(top[ia][ix], top[ia][ix + 1], top[ia + 1][ix + 1], top[ia + 1][ix]);
      }
    }
    // Boundary loop, then two skirt rings down into the hill.
    const loop: { i: number; s: number; xf: number }[] = [];
    for (let ix = 0; ix <= nX; ix++) loop.push({ i: top[0][ix], s: back, xf: (ix / nX - 0.5) * 2 });
    for (let ia = 1; ia <= nA; ia++) loop.push({ i: top[ia][nX], s: back + (front - back) * (ia / nA), xf: 1 });
    for (let ix = nX - 1; ix >= 0; ix--) loop.push({ i: top[nA][ix], s: front, xf: (ix / nX - 0.5) * 2 });
    for (let ia = nA - 1; ia >= 1; ia--) loop.push({ i: top[ia][0], s: back + (front - back) * (ia / nA), xf: -1 });
    const ringA: number[] = [];
    const ringB: number[] = [];
    for (const node of loop) {
      const j = rng(seed + index * 211 + node.i * 3);
      const lat = node.xf * halfW;
      // Waist pulled IN (undercut), foot flared out and buried — both seated on
      // the ground under their OWN xz, not under the centre line.
      const waistX = px(node.s) + ax * lat * 0.86;
      const waistZ = pz(node.s) + az * lat * 0.86;
      const ground = groundAt(waistX, waistZ);
      // How far this part of the skirt may stand proud of its own ground: a lot
      // at the spill (that overhang is the point), NOTHING outboard — an
      // unclamped waist silhouetted as a black fin off the summit ridge, and
      // even the old 0.5m allowance read as a shard from downhill.
      const lift = THREE.MathUtils.lerp(1.8, -0.12, THREE.MathUtils.smoothstep(Math.abs(node.xf), 0.40, 0.90));
      const waistY = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(dam.crest, ground, 0.6) - 0.1 * j,
        ground - 0.15,
        ground + lift,
      );
      ringA.push(rock.vert(waistX, waistY, waistZ, rockColor(waistY, dam.crest, j)));
      const footX = px(node.s - 0.2) + ax * lat * 1.16;
      const footZ = pz(node.s - 0.2) + az * lat * 1.16;
      const footY = groundAt(footX, footZ) - 0.9;
      ringB.push(rock.vert(footX, footY, footZ, rockColor(footY, dam.crest, j)));
    }
    for (let k = 0; k < loop.length; k++) {
      const k2 = (k + 1) % loop.length;
      rock.quad(loop[k].i, loop[k2].i, ringA[k2], ringA[k]);
      rock.quad(ringA[k], ringA[k2], ringB[k2], ringB[k]);
    }
  };
  dams.forEach(pushShelf);

  /** The channel the stream rides in: a rock trough whose rim stands just
   *  above the water. Built as real geometry (not a decal on the ground) so it
   *  cannot z-fight with the coarse terrain mesh, and so the water never looks
   *  painted onto grass. */
  const pushTrough = (run: WPoint[], tag: number) => {
    if (run.length < 2) return;
    let prev: number[] | null = null;
    for (let k = 0; k < run.length; k++) {
      const p = run[k];
      const j = rng(seed + tag * 97 + k * 13);
      const hw = Math.max(0.55, p.halfW);
      // Tolerance pulled in from 1.5m to 0.6m: the bank columns are seated on
      // the water line, so a metre and a half of licence let the rim stand that
      // far off its own ground on a flank — a grey rail hanging beside the
      // stream. Under 0.6 the trough simply narrows instead.
      const fit = fitLateral(p.s, p.y, hw * 1.70, 0.6) / (hw * 1.70);
      const cols: number[] = [];
      const lat = [-1.70, -1.24, -0.98, 0, 0.98, 1.24, 1.70];
      for (let c = 0; c < lat.length; c++) {
        const l = p.lat + lat[c] * hw * (0.9 + j * 0.2) * (Math.abs(lat[c]) > 0.99 ? fit : 1);
        const abs = Math.abs(lat[c]);
        const vx = px(p.s) + ax * l;
        const vz = pz(p.s) + az * l;
        const g = groundAt(vx, vz);
        // outer skirt buried · bank rim just clear of the water · bed below it.
        // The rim is allowed to sit below the water line when the ground under
        // it does: a bank that floats is a worse lie than a bank the stream
        // spills over.
        const rimY = THREE.MathUtils.clamp(
          g + 0.40 + j * 0.30, Math.min(p.y + 0.06, g + 0.55), p.y + 0.85,
        );
        const y = abs > 1.5 ? Math.min(g - 0.25, rimY - 0.55)
          : abs > 1.2 ? rimY
            : abs > 0.5 ? p.y - 0.26 - j * 0.10
              : p.y - 0.62 - j * 0.12;
        cols.push(rock.vert(vx, y, vz, rockColor(y, p.y, j)));
      }
      if (prev) for (let c = 0; c < cols.length - 1; c++) rock.quad(prev[c], prev[c + 1], cols[c + 1], cols[c]);
      prev = cols;
    }
  };
  /** The same sculpted-rock idiom, stood up on a FACE instead of laid along a
   *  bed: a recessed channel between two proud buttresses, framing a sheet
   *  pinned against a sheer wall.
   *
   *  This exists for the coastal skirt. The shore plinth is one smeared plane
   *  of sand at terrain-mesh resolution, so the two Widow's Watch shore falls
   *  poured down a blurry bare wall with nothing to say where the water was —
   *  and the bed trough, which seats its columns on the ground under each path
   *  point, collapses to a sliver there because a vertical wall gives every
   *  point of the descent the same xz. Rows go by HEIGHT instead: faceS finds
   *  where the wall stands at each one. */
  const pushFaceChute = (yTop: number, yBot: number, sFrom: number, hw: number, tag: number) => {
    const rows = Math.max(3, Math.min(18, Math.round((yTop - yBot) / 0.75)));
    // Outboard buried in the wall · buttress standing proud · bed cut back in,
    // measured along the descent axis (+s is out of the hill, into open air).
    const lat = [-2.3, -1.5, -1.05, 0, 1.05, 1.5, 2.3];
    const proud = [-0.7, 0.5, 0.12, -0.45, 0.12, 0.5, -0.7];
    let prev: number[] | null = null;
    for (let k = 0; k <= rows; k++) {
      const y = yTop - (yTop - yBot) * (k / rows);
      const s = faceS(y, sFrom);
      const j = rng(seed + tag * 71 + k * 19);
      const cols: number[] = [];
      for (let c = 0; c < lat.length; c++) {
        const abs = Math.abs(lat[c]);
        const off = lat[c] * hw * (0.92 + j * 0.22);
        const sv = s + proud[c] * (0.8 + j * 0.5);
        const vx = px(sv) + ax * off;
        const vz = pz(sv) + az * off;
        // The lip of each buttress is stepped, so the band reads as broken
        // strata rather than two smooth rails down the cliff.
        const vy = y - (abs > 1.9 ? 0.3 + j * 0.4 : j * 0.22);
        cols.push(rock.vert(vx, vy, vz, rockColor(vy, abs < 1.2 ? vy : vy + 1.5, j)));
      }
      if (prev) for (let c = 0; c < cols.length - 1; c++) rock.quad(prev[c], prev[c + 1], cols[c + 1], cols[c]);
      prev = cols;
    }
  };
  /** How many face chutes this fall grew — reported on the site so a tour probe
   *  can tell "the shore fall is framed in rock" from "it is not". */
  let faceChutes = 0;
  {
    // Which rock a stretch of the descent gets is decided by the WALL behind it,
    // not by the sheet: how far along the descent the face travels while the
    // stretch gives up its height. The coastal plinth grades past 3 (it drops
    // its whole height inside one terrain sample); an inland flank sits under
    // 1.5, and scoring the sheet instead — a ballistic plunge is steep by
    // construction — put a rock slab on the open flank of Crow's Perch, beside
    // its fall. Sheer stretches get the face chute; the rest keep the bed
    // trough wherever they actually ride the rock.
    /** Follow the wall UP from a height for as long as it stays sheer. A chute
     *  should frame the whole plinth, not the slice of it the path solver
     *  happened to split off. */
    const sheerTop = (y0: number): number => {
      let y = y0;
      for (let k = 0; k < 12; k++) {
        if (faceS(y, sCrest) - faceS(y + 0.9, sCrest) > 0.6) break;
        y += 0.9;
      }
      return y;
    };
    let run: WPoint[] = [];
    let tag = 20;
    const flush = () => {
      if (run.length > 1) {
        const yTop = run[0].y;
        const yBot = run[run.length - 1].y;
        const sTop = faceS(yTop, sCrest);
        const faceGrade = (yTop - yBot) / Math.max(0.25, faceS(yBot, sTop) - sTop);
        if (yTop - yBot > 2.2 && faceGrade > 2.5) {
          pushFaceChute(sheerTop(yTop) + 0.4, Math.max(yBot - 0.5, -1.4), Math.max(sMin, sTop - 3), chanW, tag);
          faceChutes++;
        } else if (run[0].contact) {
          pushTrough(run, tag);
        }
        tag++;
      }
      run = [];
    };
    for (const p of path) {
      if (run.length > 0 && p.contact !== run[0].contact) flush();
      run.push(p);
    }
    flush();
  }

  // ── boulders (merged, so the whole outcrop stays one draw call) ─────────
  const boulderSrc = FALL_BOULDER_GEO.getAttribute('position') as THREE.BufferAttribute;
  const bm4 = new THREE.Matrix4();
  const bv3 = new THREE.Vector3();
  /** Deterministic 0..1 from a boulder id and a vertex index. */
  const bhash = (a: number, b: number) => {
    const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const pushBoulder = (bx: number, bz: number, by: number, sc: number, k: number) => {
    bm4.compose(
      new THREE.Vector3(bx, by, bz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd(k) * 3.1, rnd(k + 1) * 6.2, rnd(k + 2) * 3.1)),
      new THREE.Vector3(sc * (0.85 + rnd(k + 3) * 0.4), sc * (0.7 + rnd(k + 4) * 0.4), sc * (0.85 + rnd(k + 5) * 0.45)),
    );
    const base = rock.pos.length / 3;
    for (let vi = 0; vi < boulderSrc.count; vi++) {
      bv3.fromBufferAttribute(boulderSrc, vi);
      // Radial jitter keyed on the SHARED vertex position, so the three copies
      // of a shared corner still land on the same point and the rock stays
      // closed. A smooth sphere reads as a pebble; a broken one reads as stone.
      const key = Math.round(bv3.x * 97) * 131 + Math.round(bv3.y * 97) * 17 + Math.round(bv3.z * 97);
      bv3.multiplyScalar(0.76 + bhash(k, key) * 0.44).applyMatrix4(bm4);
      rock.vert(bv3.x, bv3.y, bv3.z, rockColor(bv3.y, by + sc * 0.5, rnd(k + 6)));
    }
    for (let vi = 0; vi < boulderSrc.count; vi += 3) rock.idx.push(base + vi, base + vi + 1, base + vi + 2);
  };

  /** Rocks crowding the water's edge. A smooth revolved rim read as a pair of
   *  flat plates cantilevered off the hillside (verification, pass 2) — broken
   *  stone is both truer and impossible to read as a plate. */
  const pushPoolRocks = (pool: Pool, openUpstream: boolean, tag: number) => {
    const count = lowDetail ? 5 : 11;
    for (let k = 0; k < count; k++) {
      const j = rng(seed + tag * 53 + k * 29);
      const th = -Math.PI + ((k + 0.5) / count) * Math.PI * 2;
      const c = Math.cos(th);
      if (c > 0.5 || (openUpstream && c < -0.6)) continue;
      const radial = 1.02 + j * 0.28;
      const bx = px(pool.s) + dirX * c * pool.rAlong * radial + ax * Math.sin(th) * pool.rAcross * radial;
      const bz = pz(pool.s) + dirZ * c * pool.rAlong * radial + az * Math.sin(th) * pool.rAcross * radial;
      const g = groundAt(bx, bz);
      if (g < 0.7) continue;   // that is open sea, not a bank
      // Sized to the pond it rings: full-size boulders around a 2m pool read as
      // a rock pile with a puddle in it.
      const sc = (0.34 + j * 0.6) * THREE.MathUtils.clamp(pool.rAcross / 2.6, 0.65, 1.35);
      // Sit on whichever is lower — the ground or the waterline — and sink a
      // third, so a rock at the lip of a pool on a slope never floats.
      pushBoulder(bx, bz, Math.min(g, pool.y - 0.1) + sc * 0.25, sc, seed + tag * 900 + k * 17);
    }
  };
  /** A stone BOWL under a pool: a bed dished below the water line, a rim just
   *  clear of it, and a skirt buried in the ground outside.
   *
   *  Without it the plunge pool was a flat sheet of water lying on a grass
   *  hillside — nothing said the fall had cut anything, which is most of why
   *  "the fall ends with no splash-pool read". */
  const pushPoolBasin = (pool: Pool, tag: number) => {
    const segs = lowDetail ? 12 : 18;
    const cx = px(pool.s);
    const cz = pz(pool.s);
    const bedIdx: number[] = [];
    let prev: number[] | null = null;
    const ringPoint = (th: number, ring: number, wob: number) => {
      const along = Math.cos(th) * pool.rAlong * ring * wob;
      const side = Math.sin(th) * pool.rAcross * ring * wob;
      return { vx: cx + dirX * along + ax * side, vz: cz + dirZ * along + az * side };
    };
    for (let k = 0; k <= segs; k++) {
      const th = (k / segs) * Math.PI * 2;
      const j = rng(seed + tag * 271 + k * 19);
      const wob = 0.9 + 0.14 * Math.sin(th * 3 + fallIndex) + 0.07 * Math.sin(th * 5 + 1.3);
      // The water disc reaches radius 1.0 (×1.12 of wobble), so a rim drawn at
      // 1.02 was UNDER the pool it was supposed to hold. Stone starts outside
      // the water.
      const pBed = ringPoint(th, 0.55, wob);
      const pRim = ringPoint(th, 1.22, wob);
      const pWall = ringPoint(th, 1.55, wob);
      const pSkirt = ringPoint(th, 1.95, wob);
      const gRim = groundAt(pRim.vx, pRim.vz);
      const gWall = groundAt(pWall.vx, pWall.vz);
      const gSkirt = groundAt(pSkirt.vx, pSkirt.vz);
      // bed scooped under the water…
      const yBed = pool.y - 0.95 - j * 0.3;
      // …rim a hand clear of it, ALL THE WAY ROUND. The rim used to be
      // min(its own ground + a hand, the waterline): on a steep flank the
      // downhill half of the ring sits metres below the pool, so the basin
      // lost its lip exactly where you stand to look at it and the plunge pool
      // read as a sheet of water lying in mid-air off the hillside. A basin's
      // rim is the thing HOLDING the water — it never sinks below it.
      const yRim = THREE.MathUtils.clamp(gRim + 0.45 + j * 0.3, pool.y + 0.22, pool.y + 0.52);
      // …then the wall the steep site needs: on flat ground it buries within a
      // hand of the rim (exactly the old squat bowl), on a flank it stands out
      // as the stone shoulder the pool is dammed behind.
      const yWall = Math.min(yRim - 0.26 - j * 0.14, Math.max(gWall - 0.12, yRim - 3.4));
      const ySkirt = Math.min(gSkirt - 0.3, yWall - 0.25);
      // Wet-shaded against the BED, not the surface: keying the whole bowl to
      // the water line painted the rim as black as the bottom and the basin
      // read as a hole punched in the hill.
      const cols = [
        rock.vert(pBed.vx, yBed, pBed.vz, rockColor(yBed, pool.y - 0.85, j)),
        rock.vert(pRim.vx, yRim, pRim.vz, rockColor(yRim, pool.y - 0.85, j)),
        rock.vert(pWall.vx, yWall, pWall.vz, rockColor(yWall, pool.y - 0.85, j)),
        rock.vert(pSkirt.vx, ySkirt, pSkirt.vz, rockColor(ySkirt, pool.y - 0.85, j)),
      ];
      bedIdx.push(cols[0]);
      if (prev) for (let c = 0; c < cols.length - 1; c++) rock.quad(prev[c], prev[c + 1], cols[c + 1], cols[c]);
      prev = cols;
    }
    // Close the bed with a fan so the bowl has a floor, not a hole.
    const floorC = rock.vert(cx, pool.y - 1.25, cz, rockColor(pool.y - 1.25, pool.y - 0.85, 0.4));
    for (let k = 0; k < bedIdx.length - 1; k++) rock.idx.push(floorC, bedIdx[k + 1], bedIdx[k]);
  };
  pushPoolBasin(pools[pools.length - 1], 3);

  pushPoolRocks(pools[0], false, 1);
  pushPoolRocks(pools[pools.length - 1], true, 2);

  // Broken stone straddling every shelf. The shelf's own outboard skirt is now
  // buried (it used to end as a plate hovering over the grass), so the step
  // needs something to explain it from the side: real boulders, each seated
  // with the shared decor seater and sunk, are both truer and impossible to
  // read as a floating shard.
  for (let d = 0; d < dams.length; d++) {
    const dam = dams[d];
    const count = lowDetail ? 1 : 3;
    for (let k = 0; k < count; k++) {
      const j = rng(seed + d * 311 + k * 43);
      const side = k % 2 === 0 ? 1 : -1;
      const lat = side * chanW * (1.15 + j * 0.9);
      const s0 = dam.s - 0.4 + j * (dam.w + 1.0);
      const bx = px(s0) + ax * lat;
      const bz = pz(s0) + az * lat;
      // Big enough to read as a boulder rather than a pebble; anything smaller
      // than about a metre is a grey chip at any useful viewing distance.
      const sc = (0.85 + j * 0.85) * THREE.MathUtils.clamp(chanW / 2.0, 0.75, 1.4);
      const seat = ctx.seatDecor(bx, bz, sc, 0.8);
      // Same gate the bank stones use: nothing perched on a face too steep to
      // hold it, and nothing standing in the surf.
      if (seat.normal.y < 0.7 || seat.groundY < 0.7) continue;
      pushBoulder(bx, bz, seat.groundY - seat.drop - sc * 0.42, sc, seed + 5000 + d * 91 + k * 29);
    }
  }

  // Bank boulders strewn along the channel.
  if (!lowDetail) {
    const boulders = 10 + Math.round(rnd(40) * 6);
    for (let b = 0; b < boulders; b++) {
      const t = rnd(50 + b);
      const s0 = sCrest - 1.5 + (sToe + 3 - sCrest) * t;
      const side = rnd(70 + b) > 0.5 ? 1 : -1;
      const lat = side * chanW * (1.9 + rnd(90 + b) * 1.5);
      const bx = px(s0) + ax * lat;
      const bz = pz(s0) + az * lat;
      const sc = 0.42 + rnd(110 + b) * 0.75;
      // Seated with the shared decor seater and sunk: boulders pinned to the
      // analytic height alone hung visibly off the steep faces.
      const seat = ctx.seatDecor(bx, bz, sc, 0.6);
      if (seat.normal.y < 0.68 || seat.groundY < 0.7) continue;
      // …and not right on a cliff edge, where half the rock would overhang air.
      if (groundAt(bx + dirX * 1.6, bz + dirZ * 1.6) < seat.groundY - 1.6) continue;
      pushBoulder(bx, bz, seat.groundY - seat.drop - sc * 0.25, sc, seed + 3000 + b * 23);
    }
  }

  // ── mist ────────────────────────────────────────────────────────────────
  const mistPos: number[] = [];
  const mistPuff: number[] = [];
  const emit = (s: number, y: number, count: number, spread: number, rise: number) => {
    for (let k = 0; k < count; k++) {
      const j1 = rng(seed + 301 + k * 7 + s * 3);
      const j2 = rng(seed + 401 + k * 11 + s * 5);
      const j3 = rng(seed + 501 + k * 13 + s * 7);
      const lat = (j1 - 0.5) * 2 * spread;
      mistPos.push(px(s + (j2 - 0.5) * spread) + ax * lat, y + j3 * 0.5, pz(s + (j2 - 0.5) * spread) + az * lat);
      mistPuff.push(j1 * 0.97 + j2 * 0.03, 0.10 + j2 * 0.10, rise * (0.7 + j3 * 0.6), 0.5 + j1 * 1.1);
    }
  };
  const mistScale = lowDetail ? 0.4 : 1;
  for (let k = 0; k < impacts.length - 1; k++) {
    emit(impacts[k].s, impacts[k].y, Math.max(3, Math.round(10 * mistScale * impacts[k].strength)), chanW * 1.3, 2.6);
  }
  // The plunge pool: this is where the fall LANDS, and it used to get the same
  // handful of puffs as a mid-cascade step — the tail of the sheet simply ran
  // out onto grass with nothing to say water had hit anything. A dense low
  // billow plus a taller column now sits on the impact.
  emit(impact.s, baseY, Math.max(10, Math.round(40 * mistScale)), chanW * 2.5, 3.0);
  emit(impact.s, baseY + 0.4, Math.max(6, Math.round(18 * mistScale)), chanW * 1.4, 6.0);
  // A veil clinging to the sheet, so a long fall is misty all the way down
  // rather than only at the bottom.
  if (!lowDetail && drop > 8) {
    for (let k = 2; k < path.length; k += 2) {
      const p = path[k];
      if (p.y < baseY + 0.6) break;
      emit(p.s, p.y, 1, chanW * 1.1, 2.0);
    }
  }

  // ── the stream clears what it runs through ──────────────────────────────
  // Ground cover is scattered before the watercourse is solved, so tufts and
  // ferns end up standing in the middle of the fall. Collapse the instances
  // inside the channel (the standard "hide instance N" trick — a degenerate
  // matrix) rather than leaving grass growing in whitewater.
  {
    const lane: { s: number; lat: number; hw: number }[] = [];
    for (const p of path) lane.push({ s: p.s, lat: p.lat, hw: p.halfW });
    for (const pool of pools) lane.push({ s: pool.s, lat: 0, hw: Math.max(pool.rAcross, pool.rAlong) });
    lane.sort((a, b) => a.s - b.s);
    const first = lane[0];
    const last = lane[lane.length - 1];
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const child of ctx.group.children) {
      if (!(child instanceof THREE.InstancedMesh)) continue;
      if (child.name !== 'island-grass' && child.name !== 'island-ferns' && child.name !== 'island-shells') continue;
      let touched = false;
      for (let i = 0; i < child.count; i++) {
        child.getMatrixAt(i, m);
        v.setFromMatrixPosition(m);
        const ds = (v.x - originX) * dirX + (v.z - originZ) * dirZ + sMin;
        if (ds < first.s - 1 || ds > last.s + 1) continue;
        const dl = (v.x - originX) * ax + (v.z - originZ) * az;
        let near = first;
        for (const node of lane) { if (node.s > ds) break; near = node; }
        if (Math.abs(dl - near.lat) > near.hw * 1.25 + 0.35) continue;
        child.setMatrixAt(i, ZERO_SCALE_MAT4);
        touched = true;
      }
      if (touched) child.instanceMatrix.needsUpdate = true;
    }
  }

  // ── assemble ────────────────────────────────────────────────────────────
  const site = new THREE.Group();
  site.name = 'waterfall-site';
  const rockMesh = new THREE.Mesh(rock.build(), mats.rock);
  rockMesh.name = 'waterfall-rock';
  rockMesh.castShadow = !lowDetail;
  rockMesh.receiveShadow = true;
  site.add(rockMesh);

  const waterMesh = new THREE.Mesh(water.build(), mats.water);
  waterMesh.name = 'waterfall-water';
  waterMesh.renderOrder = 3;
  site.add(waterMesh);

  if (mistPos.length > 0) {
    const mistGeo = new THREE.BufferGeometry();
    mistGeo.setAttribute('position', new THREE.Float32BufferAttribute(mistPos, 3));
    mistGeo.setAttribute('aPuff', new THREE.Float32BufferAttribute(mistPuff, 4));
    const mist = new THREE.Points(mistGeo, mats.mist);
    mist.name = 'waterfall-mist';
    mist.frustumCulled = false;
    mist.renderOrder = 4;
    site.add(mist);
  }

  site.userData.island = island.name;
  site.userData.lip = { x: px(sCrest) + island.position.x, y: yCrest, z: pz(sCrest) + island.position.z };
  site.userData.base = { x: px(impact.s) + island.position.x, y: baseY, z: pz(impact.s) + island.position.z };
  site.userData.dir = { x: dirX, z: dirZ };
  site.userData.drop = drop;
  site.userData.steps = dams.length;
  site.userData.faceChutes = faceChutes;
  return site;
}

/**
 * Every tall island earns a cascade: mountains get two on opposite shoulders,
 * plateaus and twin peaks one. A fall only spawns where the search finds a real
 * descent (>= 6m over a grade of 0.3) — an island with nowhere for water to go
 * gets none rather than a strip painted on its flank.
 */
export function buildWaterfalls(ctx: IslandBuildCtx) {
  const { island, group, rng, islandSeed, lowDetail } = ctx;
  const fallCount = island.profile.terrainStyle === 'mountain' ? 2
    : (island.profile.terrainStyle === 'plateau' || island.profile.terrainStyle === 'twin') ? 1
      : 0;
  if (fallCount === 0) return;

  // Indexed ONCE for the island and shared by the search and every fall: this
  // is the hillside the falls are drawn against (see makeDrawnGround).
  const drawn = makeDrawnGround(ctx);

  let mats: { water: THREE.MeshStandardMaterial; rock: THREE.MeshStandardMaterial; mist: THREE.PointsMaterial } | null = null;
  const taken: number[] = [];
  const emitters: { x: number; y: number; z: number; scale: number }[] = [];
  for (let fall = 0; fall < fallCount; fall++) {
    const nominal = island.profile.ridgeAxis
      + Math.PI * (fall === 0 ? 0.5 : -0.55)
      + (rng(islandSeed * 47 + fall * 131) - 0.5) * 0.4;
    const course = findCourse(ctx, nominal, taken, drawn);
    if (!course) continue;
    taken.push(course.angle);
    if (!mats) {
      const sprayLight: SprayLight = { value: new THREE.Color(1, 1, 1) };
      mats = {
        water: makeWaterMaterial(ctx, sprayLight),
        rock: new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide,
        }),
        mist: makeMistMaterial(ctx, lowDetail ? 1.3 : 1.55, sprayLight),
      };
      mats.rock.name = 'waterfall-rock';
      paintFallRock(mats.rock);
      // The one per-frame write these falls make. The fx list is cleared on
      // match teardown along with the island meshes, so this cannot outlive the
      // materials it drives.
      const atmosphere = ctx.host.renderer;
      ctx.host.pushVolcanicFx(() => {
        const night = THREE.MathUtils.clamp(atmosphere.getAtmosphere().nightFactor, 0, 1);
        sprayLight.value.setRGB(1, 1, 1).lerp(SPRAY_NIGHT_TINT, night);
      });
    }
    const site = buildFall(ctx, course, fall, mats, drawn);
    if (!site) continue;
    group.add(site);
    // The audio emitter sits at the loudest point — the plunge pool — with the
    // fall's drop as its size.
    const base = site.userData.base as { x: number; y: number; z: number };
    emitters.push({
      x: base.x,
      y: base.y,
      z: base.z,
      scale: THREE.MathUtils.clamp((site.userData.drop as number) / 20, 0.35, 1.5),
    });
  }
  ctx.host.registerWaterfalls(island.id, emitters);
}
