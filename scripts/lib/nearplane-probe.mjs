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

  const EXEMPT = -1;
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

  // TWO DEPTH MATERIALS, NOT `scene.overrideMaterial`.
  //
  // The viewmodel's materials carry a clip exemption — applyViewmodelMaterialSettings
  // pins their clip-space z so a weapon can never be cut by the near plane (they
  // neither test nor write depth, so the value is not information). A single
  // `scene.overrideMaterial` replaces that exemption along with everything else,
  // and the probe then reports the weapon being clipped by a plane that does not
  // clip it — measured, it claimed 41,024 pixels off the cutlass that the real
  // render keeps. A probe that overrides the property under test is not
  // measuring the game.
  //
  // So the swap is per mesh, and a mesh whose material is exempt gets a depth
  // material carrying the SAME exemption. The flag is the one the client sets.
  cache.plain ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (!cache.exempt) {
    cache.exempt = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    cache.exempt.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(/\}\s*$/, '\tgl_Position.z = 0.0;\n}');
    };
    cache.exempt.customProgramCacheKey = () => 'probe-depth-noclip';
  }
  const swapped = [];
  const hidden = [];
  const isExempt = (m) => (Array.isArray(m) ? m.some((x) => x?.__vmNoClip) : !!m?.__vmNoClip);
  const swapIn = () => {
    scene.traverse((o) => {
      if (!o.material) return;
      // SPRITES, POINTS AND LINES ARE HIDDEN, NOT SWAPPED. three draws each of
      // those through its own geometry and draw mode; handed a mesh depth
      // material they run a mesh program over attributes that program never
      // declared, and the result is not merely wrong, it is UNSTABLE — two
      // identical passes disagreed by up to 81,131 pixels, and only at the
      // stands full of motes, wisps and birds. Omitting them costs the probe the
      // ability to see a particle clipped by the near plane; keeping them cost
      // it the ability to see anything at all.
      if (o.isSprite || o.isPoints || o.isLine) {
        if (o.visible) { hidden.push(o); o.visible = false; }
        return;
      }
      swapped.push([o, o.material]);
      o.material = isExempt(o.material) ? cache.exempt : cache.plain;
    });
  };
  const swapOut = () => {
    for (const [o, m] of swapped) o.material = m;
    for (const o of hidden) o.visible = true;
    swapped.length = 0;
    hidden.length = 0;
  };

  /** Render the frame's depth at a given near plane into cache.raw. */
  const pass = (near) => {
    const prevNear = camera.near;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    camera.near = near;
    camera.updateProjectionMatrix();
    swapIn();
    performance.now = () => frozenAt;
    // WHITE, ALPHA 1: RGBADepthPacking of 1.0 is (1,1,1,1), so an unwritten
    // pixel reads back as "the far plane" instead of "a surface at the eye" —
    // which is exactly the mistake the first version of this probe made.
    renderer.setClearColor(0xffffff, 1);
    // STATED, NOT INHERITED. A pass that renders onto the PREVIOUS pass's depth
    // buffer depth-tests against a frame taken from another camera, and the two
    // control passes then disagree with each other by a third of the screen —
    // which is exactly what the control reported before this line existed.
    renderer.autoClear = true;
    try {
      renderer.setRenderTarget(cache.rt);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(cache.rt, 0, 0, w, h, cache.raw);
    } finally {
      swapOut();
      camera.near = prevNear;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
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
      // THE EXEMPT SENTINEL. A clip-exempt material writes ndc z = 0 exactly, so
      // its window depth is 0.5 to the bit — which converts to 0.1 m at near
      // 0.05 and 0.4 m at near 0.2, and the naive reading is that every pixel of
      // the player's own cutlass "moved 30 cm farther" and was clipped. It did
      // not move: it has no depth at all, by construction. Those pixels are
      // marked and take no part in the comparison.
      if (Math.abs(d - 0.5) < 2e-5) { out[p] = EXEMPT; continue; }
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
  const moved = (da, db) => da !== EXEMPT && db !== EXEMPT && db > da * 1.02 + 0.01;
  // THE CONTROL IS A MASK, NOT A FOOTNOTE. A pixel the two identical passes
  // already disagree about cannot testify about the near plane, so it is struck
  // from the count rather than argued about — and `selfNoise` is reported beside
  // every reading so nobody mistakes a heavily-masked stand for a clean one.
  const noisy = new Uint8Array(a.length);
  let selfNoise = 0;
  for (let p = 0; p < a.length; p += 1) {
    if (moved(a[p], cache.c[p]) || moved(cache.c[p], a[p])) { noisy[p] = 1; selfNoise += 1; }
  }
  const lostMask = new Uint8Array(a.length);
  let lost = 0;
  let worstGain = 0;
  let worstAt = null;
  let nearestA = Infinity;
  let nearestB = Infinity;
  let covered = 0;
  for (let p = 0; p < a.length; p += 1) {
    const da = a[p];
    const db = b[p];
    if (da !== EXEMPT && da < emptyAt) {
      covered += 1;
      if (da < nearestA) nearestA = da;
    }
    if (db !== EXEMPT && db < emptyAt && db < nearestB) nearestB = db;
    // A surface that moved FARTHER lost whatever used to be in front of it.
    // The tolerance is the depth buffer's own quantisation at that distance,
    // generously: a tie reshuffle moves a pixel by well under a millimetre at
    // 1 m and by centimetres at 500 m, and a clip moves it by metres.
    if (!noisy[p] && moved(da, db)) {
      lostMask[p] = 1;
      lost += 1;
      const gain = db - da;
      if (gain > worstGain) {
        worstGain = gain;
        worstAt = { x: p % w, y: h - 1 - ((p / w) | 0), fromM: Number(da.toFixed(3)), toM: Number(db.toFixed(3)) };
      }
    }
  }

  // A HOLE HAS AN INSIDE; A RE-CLIPPING SLIVER DOES NOT.
  //
  // "Zero lost pixels" is not a satisfiable claim about ANY near-plane change,
  // and it took a clean run to see why. Large ground and foliage triangles pass
  // UNDER the eye — their far vertices are metres away but the polygon crosses
  // the near plane — so moving the plane re-clips them, and the new clip edge
  // lands a pixel or two from the old one. Measured at 0.1: 1, 1 and 13 pixels
  // at three of seventeen stands, with self-noise 0, and the same 13 at 0.2 and
  // 0.3. It is an edge, not a hole, and it is inherent.
  //
  // So the gate asks the structural question instead: does the loss have an
  // INTERIOR? A pixel whose four neighbours are all lost is inside a region at
  // least three pixels across — a hole in the picture. A one-pixel-wide clip
  // edge has no such pixel anywhere along it, at any length. Both numbers are
  // returned; the assertion is on the second.
  let holePixels = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      if (!lostMask[p]) continue;
      if (lostMask[p - 1] && lostMask[p + 1] && lostMask[p - w] && lostMask[p + w]) holePixels += 1;
    }
  }

  return {
    lost,
    holePixels,
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
