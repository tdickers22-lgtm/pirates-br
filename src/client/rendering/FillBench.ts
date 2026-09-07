/**
 * HOW FAST CAN THIS MACHINE ACTUALLY SHADE?
 *
 * Every other input the tier detector has is a fact about the CPU or about a
 * string, used to answer a question about a GPU (PERF-01/perf-20). In Safari on
 * Apple silicon they are ALL opaque at once — the renderer string is
 * `Apple GPU`, WebKit clamps `hardwareConcurrency`, `deviceMemory` does not
 * exist — so a rule table alone cannot tell an M2 Air from an M2 Ultra, and
 * `low` is the only safe default. That is correct and it is also a permanent
 * half-tier loss on the fastest Macs unless something MEASURES them.
 *
 * Fill rate is the one number the ladder actually spends, it is backend
 * independent (docs/FRAME_COST_MODEL.md §0), and it can be measured in under
 * two seconds on the menu with no world, no assets and no match to disturb.
 *
 * WHAT IT WILL NOT DO:
 * - It never runs while a match is live, and never when the tier was pinned
 *   with `?quality=` or chosen in settings — a benchmark competing with the
 *   frame it is trying to characterise measures the competition.
 * - It never blocks the main thread for a frame the player could feel. The work
 *   is a fixed number of small passes on a 320x180 offscreen target, run one
 *   batch per animation frame with a wall-clock deadline, on its OWN context so
 *   it cannot touch the game's state, and torn down (`WEBGL_lose_context`) the
 *   moment it has an answer.
 * - It never changes the tier THIS session. Like the audition and the promotion
 *   proof, it is written for the next launch: the tier decides the shadow map,
 *   the sky dome and every island's material set.
 *
 * The shader is a stand-in for the ocean's, not an import of it: OCEAN_FRAG is
 * private to OceanRenderer and carries uniforms and a fog term that only exist
 * inside a scene. What is reproduced is the COST SHAPE — a four-wave sum, a
 * normal, a specular term and a two-way mix per fragment — because the number
 * wanted is Mpx/s on shader-heavy fill, not a pixel-exact ocean.
 */
import {
  parseRenderQuality, loadQualityPreference, loadBenchScore, saveBenchScore, tierForBenchScore,
} from './QualityPreference.js';

const BENCH_VERT = /* glsl */`
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/** The ocean's cost shape: four Gerstner-style waves, a normal from them, a
 *  specular lobe and a depth mix. No textures — this measures ALU+ROP, which is
 *  what the tier ladder's resolution lever buys back. */
const BENCH_FRAG = /* glsl */`
precision highp float;
uniform vec2 u_res;
uniform float u_time;
void main() {
  vec2 p = gl_FragCoord.xy / u_res;
  vec3 acc = vec3(0.0);
  float h = 0.0;
  vec2 d = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float f = 3.0 + float(i) * 2.7;
    vec2 dir = normalize(vec2(cos(float(i) * 1.7), sin(float(i) * 2.3)));
    float phase = dot(dir, p) * f + u_time * (0.6 + float(i) * 0.13);
    float s = sin(phase);
    h += s / f;
    d += dir * cos(phase);
  }
  vec3 n = normalize(vec3(-d.x, 2.0, -d.y));
  vec3 l = normalize(vec3(0.4, 0.8, 0.2));
  vec3 v = normalize(vec3(0.0, 1.0, -1.0));
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 48.0);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 shallow = vec3(0.18, 0.62, 0.66);
  vec3 deep = vec3(0.02, 0.14, 0.28);
  acc = mix(deep, shallow, clamp(h * 2.0 + 0.5, 0.0, 1.0));
  acc = mix(acc, vec3(0.7, 0.85, 0.95), fres * 0.6) + spec;
  acc = mix(acc, vec3(0.55, 0.68, 0.78), 0.25);
  gl_FragColor = vec4(acc, 1.0);
}
`;

const BENCH_W = 320;
const BENCH_H = 180;
/** Full-screen passes per animation frame. Two passes of 320x180 is 115k
 *  fragments — about a fifth of what the `low` tier draws in ONE frame at its
 *  smallest, so a batch can never be the longest frame in the session. */
const PASSES_PER_BATCH = 2;
/** Total passes wanted. 96 x 57.6 kpx = 5.5 Mpx of shading, which is enough to
 *  separate 40 Mpx/s software rasterisation from 3 Gpx/s silicon. */
const TOTAL_PASSES = 96;
/** ABORT IF THE PAGE IS BUSY. The bench is only ever allowed to run on frames
 *  nobody wanted. If the gap between two of its own batches exceeds this, some
 *  other work owns the frame — a match started, an island is streaming in — and
 *  the honest thing is to leave with no score rather than to add fill to a
 *  frame the player can already feel. Retried next launch. */
const BUSY_FRAME_MS = 25;
/** Hard wall-clock cap. A machine that cannot finish in this gets no score,
 *  which routes it to the safe default rather than to a guess. */
const DEADLINE_MS = 1500;

let inFlight: Promise<number | null> | null = null;

/**
 * Run the benchmark and return Mpx/s, or null when it could not be measured
 * (no WebGL, a lost context, or the deadline passed). Idempotent per session.
 */
export function runFillBench(): Promise<number | null> {
  if (inFlight) return inFlight;
  inFlight = measure();
  return inFlight;
}

function measure(): Promise<number | null> {
  return new Promise((resolve) => {
    let gl: WebGLRenderingContext | null = null;
    const finish = (score: number | null) => {
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
      resolve(score);
    };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = BENCH_W;
      canvas.height = BENCH_H;
      gl = (canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false })
        ?? canvas.getContext('webgl', { antialias: false, depth: false, stencil: false })) as WebGLRenderingContext | null;
      if (!gl) return finish(null);

      const program = buildProgram(gl);
      if (!program) return finish(null);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.useProgram(program);
      gl.uniform2f(gl.getUniformLocation(program, 'u_res'), BENCH_W, BENCH_H);
      const uTime = gl.getUniformLocation(program, 'u_time');
      gl.viewport(0, 0, BENCH_W, BENCH_H);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // One warm batch, untimed: the first draw of a program pays for the
      // driver's link join, which is a fact about compilation, not fill.
      for (let i = 0; i < PASSES_PER_BATCH; i += 1) {
        gl.uniform1f(uTime, i * 0.01);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.finish();

      const startedAt = performance.now();
      let done = 0;
      let shadedMs = 0;
      let lastBatchEnded = performance.now();
      const batch = () => {
        const g = gl;
        if (!g || g.isContextLost()) return finish(null);
        const t0 = performance.now();
        if (done > 0 && t0 - lastBatchEnded > BUSY_FRAME_MS) return finish(null);
        for (let i = 0; i < PASSES_PER_BATCH; i += 1) {
          g.uniform1f(uTime, (done + i) * 0.017);
          g.drawArrays(g.TRIANGLES, 0, 3);
        }
        // The only synchronous point, and it is bounded by the batch size: four
        // small passes are microseconds on real silicon and a few milliseconds
        // on a software rasteriser, which is itself the answer.
        g.finish();
        lastBatchEnded = performance.now();
        shadedMs += lastBatchEnded - t0;
        done += PASSES_PER_BATCH;
        if (done >= TOTAL_PASSES) {
          const pixels = done * BENCH_W * BENCH_H;
          return finish(shadedMs > 0 ? (pixels / 1e6) / (shadedMs / 1000) : null);
        }
        if (performance.now() - startedAt > DEADLINE_MS) return finish(null);
        requestAnimationFrame(batch);
        return undefined;
      };
      requestAnimationFrame(batch);
    } catch {
      finish(null);
    }
  });
}

function buildProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const compile = (type: number, src: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, BENCH_VERT);
  const fs = compile(gl.FRAGMENT_SHADER, BENCH_FRAG);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  return program;
}

/**
 * The menu's entry point: measure this machine once, in the background, and
 * store the score for the NEXT launch.
 *
 * Returns immediately on every path that must not run it — a pinned tier, a
 * player-chosen tier, a machine that already has a score, or a document that is
 * not visible (a hidden tab's rAF never fires and its GPU is throttled).
 */
export function ensureFillBench(rendererString: string | null): void {
  try {
    if (parseRenderQuality(new URLSearchParams(window.location.search).get('quality'))) return;
    if (loadQualityPreference() !== 'auto') return;
    if (loadBenchScore(rendererString) !== null) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  } catch {
    return;
  }
  void runFillBench().then((score) => {
    if (score === null) return;
    saveBenchScore(score, rendererString);
    console.info(`[quality] fill bench: ${score.toFixed(0)} Mpx/s → '${tierForBenchScore(score)}' is offered next launch.`);
  });
}
