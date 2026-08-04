// WHAT DOES RAISING THE NEAR PLANE COST THE PICTURE?
//
// The near plane is the single biggest lever on depth precision — the usable
// range of a fixed-point depth buffer is set by the near:far RATIO, and this
// game shipped 0.05:3000, which spends most of the buffer on the first few
// metres and leaves the rest of the world resolving at ten centimetres a level.
//
// It is also the one change that can put a HOLE in the picture, because
// everything nearer than the plane is clipped away. So the raise needs a second
// number beside the precision one: how much of the frame it costs.
//
// THE FIRST TWO INSTRUMENTS FOR THIS WERE BOTH WRONG, in instructive ways.
//
//   • "Measure the nearest drawn surface and keep the plane inside it." The
//     depth target's UNWRITTEN pixels read back as the renderer's clear colour,
//     which unpacks to a depth of ~0, so every stand reported the probe's own
//     near plane with 100% coverage. A probe whose empty answer and whose worst
//     answer are the same number cannot be read at all.
//   • "Measure the nearest camera-attached vertex." It reported a lantern vertex
//     0.5 mm from the eye — which is 0.0005 m, i.e. already inside the 0.05 m
//     plane the game has always shipped, already clipped, and visibly harming
//     nothing. An absolute clearance measures geometry that left the frame long
//     ago; the question was never "what is close", it is "what does the RAISE
//     take away".
//
// So measure the difference. Render the depth of the frame twice from the same
// pose and the same world state, once at the historical near plane and once at
// the candidate, convert both to METRES, and count the pixels where the nearest
// surface got FARTHER. A pixel that lost its nearest surface to the new plane is
// showing whatever was behind it instead, and that is what clipping IS.
//
// Depth in metres is the right comparison and colour is not: two surfaces
// swapping across a depth-buffer tie change the colour of a pixel without moving
// it a millimetre, and the tie count is the other gate's business. A clip moves
// the surface by metres. The signals do not overlap.
//
// The measurement is conservative in the safe direction — `scene.overrideMaterial`
// draws alpha-tested foliage as whole opaque quads and sprites/points as their
// full geometry, so a leaf card the alpha test would have thrown away still
// counts as a surface that the near plane could take.

/**
 * WHAT THE RAISE TAKES AWAY, in pixels.
 *
 * @param opts.baselineNear  the near plane to compare against (0.05, what the
 *                           game shipped before this campaign).
 * @returns { lost, lostFraction, worstGainM, nearestBaselineM, nearestShippedM,
 *            coverage, shippedNear, samples } — `lost` is the number of pixels
 *            whose nearest surface moved farther away, which is the number of
 *            pixels of geometry the raise cost.
 */
export const CLIP_LOSS_CENSUS = async (opts = {}) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const camera = R.camera;
  const scene = R.scene;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;

  const cache = (window.__nearProbe ??= {});
  if (!cache.rt || cache.rt.width !== w || cache.rt.height !== h) {
    cache.rt?.dispose?.();
    cache.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    cache.raw = new Uint8Array(w * h * 4);
    cache.a = new Float32Array(w * h);
    cache.b = new Float32Array(w * h);
    cache.c = new Float32Array(w * h);
  }
  cache.mat ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

  const far = camera.far;
  const shippedNear = camera.near;
  const baselineNear = opts.baselineNear ?? 0.05;

  // FREEZE THE WALL CLOCK FOR THE DURATION OF THE CENSUS.
  //
  // A probe that renders the scene more than once is a probe that has to know
  // what a render CHANGES, and in this game a render advances animation:
  // MiscMeshFactory's station halo carries `onBeforeRender = () => animate(
  // performance.now() / 1000)`, and CombatFx's points and impostors re-orient in
  // theirs. Those callbacks fire once per `renderer.render()`, not once per game
  // frame, so a second pass draws a slightly different world — the control
  // reported up to 14,247 pixels of disagreement between two passes at the SAME
  // near plane before this was here.
  //
  // Stubbing performance.now is the total fix rather than the per-callback one:
  // anything animating off wall-clock time stands still for all three passes,
  // whether this file knows about it or not.
  const realNow = performance.now.bind(performance);
  const frozenAt = realNow();

  /** Render the frame's depth at a given near plane into cache.raw. */
  const pass = (near) => {
    const prevNear = camera.near;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    camera.near = near;
    camera.updateProjectionMatrix();
    scene.overrideMaterial = cache.mat;
    performance.now = () => frozenAt;
    // WHITE, ALPHA 1: RGBADepthPacking of 1.0 is (1,1,1,1), so an unwritten
    // pixel reads back as "the far plane" instead of "a surface at the eye" —
    // which is exactly the mistake the first version of this probe made.
    renderer.setClearColor(0xffffff, 1);
    try {
      renderer.setRenderTarget(cache.rt);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(cache.rt, 0, 0, w, h, cache.raw);
    } finally {
      scene.overrideMaterial = null;
      camera.near = prevNear;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevClearAlpha);
      performance.now = realNow;
    }
  };

  // THE ALPHA CHANNEL IS THE MOST SIGNIFICANT BYTE, not the red one. three's
  // packDepthToRGBA is `vec4 r = vec4( fract( v * vec3(256^3, 256^2, 256) ), v )`
  // with the borrows subtracted and the whole thing scaled by 256/255 — so w
  // carries the coarse depth and x carries the finest bits, which is the reverse
  // of the obvious reading. Unpacked the obvious way, an unwritten white pixel
  // came out at depth 1.0039, the perspective divide went through zero, and
  // every stand reported a NEGATIVE distance of -78 m. The sign is what gave it
  // away; a subtler packing error would have been read as data.
  const unpack = (near, out) => {
    const raw = cache.raw;
    for (let i = 0, p = 0; i < raw.length; i += 4, p += 1) {
      const d = Math.min(1, (
        (raw[i] / 255) / 16777216
        + (raw[i + 1] / 255) / 65536
        + (raw[i + 2] / 255) / 256
        + (raw[i + 3] / 255)
      ) * (255 / 256));
      // Window depth -> metres along the view axis, with THIS pass's near plane.
      const ndc = d * 2 - 1;
      out[p] = (2 * near * far) / (far + near - ndc * (far - near));
    }
  };

  // THE CONTROL COMES FIRST. Two passes at the SAME near plane must agree
  // everywhere; anything they disagree about is the instrument's own noise and
  // is subtracted from nothing — it invalidates the reading. The first version
  // of this probe had no control and reported that raising the near plane cost
  // 196,679 pixels at a stand whose nearest surface had not moved a millimetre,
  // which is a contradiction a control would have caught in one run.
  pass(baselineNear);
  unpack(baselineNear, cache.a);
  pass(baselineNear);
  unpack(baselineNear, cache.c);
  pass(shippedNear);
  unpack(shippedNear, cache.b);

  const a = cache.a;
  const b = cache.b;
  const emptyAt = far * 0.995;
  const moved = (da, db) => db > da * 1.02 + 0.01;
  let selfNoise = 0;
  for (let p = 0; p < a.length; p += 1) {
    if (moved(a[p], cache.c[p]) || moved(cache.c[p], a[p])) selfNoise += 1;
  }
  let lost = 0;
  let worstGain = 0;
  let worstAt = null;
  let nearestA = Infinity;
  let nearestB = Infinity;
  let covered = 0;
  for (let p = 0; p < a.length; p += 1) {
    const da = a[p];
    const db = b[p];
    if (da < emptyAt) {
      covered += 1;
      if (da < nearestA) nearestA = da;
    }
    if (db < emptyAt && db < nearestB) nearestB = db;
    // A surface that moved FARTHER lost whatever used to be in front of it.
    // The tolerance is the depth buffer's own quantisation at that distance,
    // generously: a tie reshuffle moves a pixel by well under a millimetre at
    // 1 m and by centimetres at 500 m, and a clip moves it by metres.
    if (moved(da, db)) {
      lost += 1;
      const gain = db - da;
      if (gain > worstGain) {
        worstGain = gain;
        worstAt = { x: p % w, y: h - 1 - ((p / w) | 0), fromM: Number(da.toFixed(3)), toM: Number(db.toFixed(3)) };
      }
    }
  }

  return {
    lost,
    selfNoise,
    lostFraction: Number((lost / (w * h)).toFixed(6)),
    worstGainM: Number(worstGain.toFixed(3)),
    worstAt,
    nearestBaselineM: isFinite(nearestA) ? Number(nearestA.toFixed(4)) : null,
    nearestShippedM: isFinite(nearestB) ? Number(nearestB.toFixed(4)) : null,
    coverage: Number((covered / (w * h)).toFixed(4)),
    baselineNear,
    shippedNear,
    width: w,
    height: h,
  };
};
