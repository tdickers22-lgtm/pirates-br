// SHIP DRESSING — the hand-built fittings that hang on the hull: window
// frames, rope coils, barrels, the figurehead, hatch gratings, lanterns and the
// flags. Extracted verbatim from ShipRenderer (codehealth-03 phase 1,
// HULLGEO-01 slice a); scripts/test-ship-geometry-hash.mjs pins the move.
import * as THREE from 'three';
import { CYLINDER_UP } from './geometry.js';
import { drawFlagEmblem } from './emblems.js';
import { textureRng } from './textures.js';

export function makeCylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  segments = 8,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.001), segments), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  if (length > 0.0001) {
    mesh.quaternion.setFromUnitVectors(CYLINDER_UP, dir.normalize());
  }
  mesh.castShadow = true;
  return mesh;
}

/** A coiled rope flaked down on the deck: an irregular flattened spiral of 2-3
 *  overlapping turns with a loose tail, instead of the perfect torus that read
 *  as a rubber donut in the deck audit. Deterministic from `seed` so a given
 *  station coils the same way on every client. Returns a group centred on the
 *  coil, sitting on y = 0 (its own thickness is the standing height). */
export function makeRopeCoil(
  material: THREE.Material,
  outerRadius: number,
  thickness: number,
  seed = 0,
  turns = 2.6,
  /** Tube sides: 6; phones pass 4 (b4.2h phone own-hull cap). */
  radial = 6,
): THREE.Group {
  const g = new THREE.Group();
  const rnd = (i: number) => {
    const s = Math.sin((seed + 1) * 12.9898 + i * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  // Flaked coil: the rope spirals inward and settles, so each turn sits a
  // little lower and a little tighter than the one outside it.
  const points: THREE.Vector3[] = [];
  const steps = Math.max(18, Math.round(turns * 14));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    // Slight ovality + per-coil wobble kills the machined-circle read.
    const wob = 1 + (rnd(i * 0.37) - 0.5) * 0.13;
    const r = outerRadius * (1 - 0.34 * t) * wob;
    points.push(new THREE.Vector3(
      Math.cos(a) * r * 1.06,
      thickness * (0.55 + 0.42 * (1 - t)) + Math.sin(a * 2 + seed) * thickness * 0.1,
      Math.sin(a) * r * 0.94,
    ));
  }
  // Loose tail flaked off to one side and dropped flat on the deck.
  const tailA = turns * Math.PI * 2;
  const tailR = outerRadius * 0.66;
  points.push(new THREE.Vector3(
    Math.cos(tailA) * tailR + outerRadius * 0.55,
    thickness * 0.5,
    Math.sin(tailA) * tailR + outerRadius * (rnd(9) - 0.5) * 0.9,
  ));
  points.push(new THREE.Vector3(
    Math.cos(tailA) * tailR + outerRadius * 1.35,
    thickness * 0.42,
    Math.sin(tailA) * tailR + outerRadius * (rnd(11) - 0.5) * 1.4,
  ));
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.35);
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(24, steps + 6), thickness * 0.5, radial, false),
    material,
  );
  tube.castShadow = true;
  g.add(tube);
  return g;
}

export function makeBarrel(
  woodMat: THREE.Material,
  hoopMat: THREE.Material,
  lidMat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();

  // Barrel body — rounded cylinder approximated with tapered ends
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.72, 16),
    woodMat,
  );
  body.castShadow = true;
  g.add(body);

  // Bulge rings (hoops)
  for (const hy of [-0.22, 0, 0.22]) {
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.4, 0.045, 6, 14),
      hoopMat,
    );
    hoop.rotation.x = Math.PI * 0.5;
    hoop.position.y = hy;
    hoop.castShadow = true;
    g.add(hoop);
  }

  // Top lid with colour indicating contents
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 16),
    lidMat,
  );
  lid.position.y = 0.39;
  lid.castShadow = true;
  g.add(lid);

  // Bottom cap
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 0.06, 16),
    woodMat,
  );
  cap.position.y = -0.39;
  g.add(cap);

  return g;
}

/** Cargo-hatch grating: a framed grid of slats. Cheap deck furniture; light shows
 *  through the gaps so the hold (and rising water) reads from above. */
export function makeHatchGrating(
  w: number,
  l: number,
  frameMat: THREE.Material,
  slatMat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const fh = 0.12;
  const hw = w * 0.5, hl = l * 0.5;
  for (const [x, z, bw, bl] of [
    [0, hl, w + 0.08, 0.08],
    [0, -hl, w + 0.08, 0.08],
    [hw, 0, 0.08, l],
    [-hw, 0, 0.08, l],
  ] as const) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(bw, fh, bl), frameMat);
    frame.position.set(x, 0, z);
    frame.castShadow = true;
    g.add(frame);
  }
  const barsX = Math.max(3, Math.round(w / 0.28));
  const barsZ = Math.max(3, Math.round(l / 0.28));
  for (let i = 1; i < barsX; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, fh * 0.7, l), slatMat);
    bar.position.set(-hw + (i / barsX) * w, -0.01, 0);
    g.add(bar);
  }
  for (let i = 1; i < barsZ; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, fh * 0.55, 0.04), slatMat);
    bar.position.set(0, -0.02, -hl + (i / barsZ) * l);
    g.add(bar);
  }
  return g;
}

/** Warm ship lantern fixture: an emissive amber glass core in a dark metal cage
 *  with a hanging hook. The glass uses the SHARED glassMat so it merges into one
 *  controllable mesh whose emissive ramps with night. */
export function makeLanternFixture(glassMat: THREE.Material, metalMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.2), glassMat);
  glass.position.y = 0;
  g.add(glass);
  // Cage: top + bottom caps and four corner posts
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 0.1, 10), metalMat);
  cap.position.y = 0.2;
  cap.castShadow = true;
  g.add(cap);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.08, 10), metalMat);
  base.position.y = -0.18;
  g.add(base);
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.32, 0.02), metalMat);
      post.position.set(sx * 0.1, 0, sz * 0.1);
      g.add(post);
    }
  }
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 5, 8), metalMat);
  hook.position.y = 0.3;
  hook.rotation.x = Math.PI * 0.5;
  g.add(hook);
  return g;
}


export const FLAG_FLY = 0.85;
export const FLAG_DROP = 0.44;

/** One flag texture per team colour (there are ~16), shared by every ship on
 *  that team — the crew emblem is PAINTED on rather than built from little
 *  spheres and boxes, so the blazon deforms with the cloth for free and the
 *  whole flag stays a single draw call. */
export const flagTextureCache = new Map<number, THREE.CanvasTexture>();

export function flagTexture(teamColor: number): THREE.CanvasTexture {
  const cached = flagTextureCache.get(teamColor);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const hex = `#${teamColor.toString(16).padStart(6, '0')}`;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 256, 128);
  // Weathered cloth: a few sun-bleached patches and horizontal seam stitching so
  // the flag doesn't read as a flat swatch of colour.
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#ffffff';
  const rnd = textureRng(0xf1a6 ^ (teamColor >>> 0));
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.arc(rnd() * 256, rnd() * 128, 10 + rnd() * 22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  for (let y = 20; y < 128; y += 26) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The crew emblem (b4.3e, crossdevice-15): one shape per crew, so the
  // ensign reads by silhouette, not by hue alone. The skull is crew 0's.
  drawFlagEmblem(ctx, teamColor);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  flagTextureCache.set(teamColor, tex);
  return tex;
}

/** Drives the flag's vertex ripple. */
export interface FlagUniforms {
  uFlagTime: { value: number };
  /** x = ripple amplitude in metres, y = per-ship phase offset in radians. */
  uFlagWave: { value: THREE.Vector2 };
}

export interface ShipFlag {
  /** Yawed to the wind each frame; the flag hangs off its +X axis. */
  pivot: THREE.Group;
  uniforms: FlagUniforms;
}

/** Deterministic 0..2π phase from a ship id, so a fleet at anchor doesn't
 *  flutter in lockstep like one animation played on every hull. */
export function flagPhaseFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/**
 * Cheap cloth ripple, entirely in the vertex shader: a travelling sine along
 * the fly whose amplitude ramps quadratically from the hoist (pinned to the
 * halyard, so it never detaches from the mast) out to the free end. Costs no
 * per-frame CPU geometry work — only the two meshes it keeps out of the static
 * hull merge. The surface normal is re-aimed from the analytic slope of the main
 * wave, so the cloth catches light as it undulates instead of shading flat.
 */
export function applyFlagWave(material: THREE.Material, uniforms: FlagUniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFlagTime = uniforms.uFlagTime;
    shader.uniforms.uFlagWave = uniforms.uFlagWave;
    const preamble = `
      uniform float uFlagTime;
      uniform vec2 uFlagWave;
      // Hoist (x=0) is pinned; the fly end (x=FLAG_FLY) swings the most.
      float flagAmp(vec3 p) {
        float hoist = clamp(p.x / ${FLAG_FLY.toFixed(3)}, 0.0, 1.0);
        return uFlagWave.x * hoist * hoist;
      }
      float flagWaveZ(vec3 p) {
        float a = flagAmp(p);
        return sin(p.x * 9.0 - uFlagTime * 7.0 + uFlagWave.y) * a
             + sin(p.y * 6.0 - uFlagTime * 4.3 + uFlagWave.y * 1.7) * a * 0.35;
      }
    `;
    shader.vertexShader = preamble + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      vec3 transformed = vec3( position );
      transformed.z += flagWaveZ( position );
      // A rippling flag is a little shorter end-to-end than a flat one, and the
      // free end lifts on the gust.
      float flagH = clamp( position.x / ${FLAG_FLY.toFixed(3)}, 0.0, 1.0 );
      transformed.x -= uFlagWave.x * flagH * flagH * 0.55;
      transformed.y += cos( position.x * 7.0 - uFlagTime * 6.0 + uFlagWave.y ) * flagAmp( position ) * 0.3;
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `
      vec3 objectNormal = vec3( normal );
      // d(waveZ)/dx of the dominant term — the cloth plane's own normal is +Z,
      // so tilting by the slope is a single component tweak.
      objectNormal = normalize( objectNormal + vec3(
        -cos( position.x * 9.0 - uFlagTime * 7.0 + uFlagWave.y ) * 9.0 * flagAmp( position ),
        0.0, 0.0 ) );
      `,
    );
  };
  // This patches the standard program source, so it must not share a compiled-
  // shader cache slot with a plain standard material.
  material.customProgramCacheKey = () => 'flag-wave-cloth';
}

