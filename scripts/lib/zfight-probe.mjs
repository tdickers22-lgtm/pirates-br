// THE Z-FIGHTING INSTRUMENT: A TIE IN THE DEPTH TEST IS THE ARTIFACT ITSELF.
//
// WHY THIS IS NOT A FRAME DIFF. The obvious probe is to dolly the camera and
// diff consecutive frames, and it does not work in this game: the ocean, the
// foliage sway, the clouds, the rain, the day clock and every particle pool are
// all moving, so a frame diff of a moving camera reports the whole screen and
// buries the artifact it was built to find. Worse, it is a SAMPLING probe — it
// sees a fight only on the frames where the fight happened to flip.
//
// So measure the CAUSE, exactly, instead of sampling the symptom.
//
// Z-fighting is one thing and one thing only: two fragments from different
// surfaces whose window-space depths land on the SAME quantised depth value, so
// which of them survives is decided by something other than geometry — the draw
// order, and the comparison operator. Every three material in this game runs the
// default `LessEqualDepth`, under which the LAST of a tied pair wins. Flip the
// comparison to `LessDepth` and the FIRST of a tied pair wins instead.
//
// Render the same world state twice, changing nothing but that operator:
//
//   • a pixel with no tie is byte-identical in both renders — the winner is
//     strictly nearer than everything else, and `<` and `<=` agree about it;
//   • a pixel WITH a tie changes, because the two operators pick different
//     surfaces out of the tie.
//
// The count of changed pixels is therefore the exact count of pixels standing on
// a depth-buffer tie: the pixels an infinitesimal camera move can flip, which is
// the definition of the artifact. It needs no motion, no animation, no
// threshold and no judgement — a clean frame reads exactly 0.
//
// The sweep is what turns an exact per-pose answer into a claim about motion. A
// coplanar pair that is 1 LSB apart at one pose is TIED half a metre later, so
// each stand is measured at several poses along a slow dolly and the scene's
// score is the worst of them.
//
// SELF-NOISE IS MEASURED, NOT ASSUMED. Every census first renders twice with
// NOTHING changed and counts the difference. That number must be 0. If it is
// not, something in the frame is advancing between the two renders (a warmer
// releasing a material, an animation clock) and no tie count from that stand
// means anything. It is reported beside every measurement.

// three's depth-comparison constants, by value, so no import is needed in-page.
// They are re-declared INSIDE the census rather than shared from module scope:
// page functions are serialised to source and evaluated in the browser, where
// nothing this file's module scope holds exists.

/**
 * Pin the resolution so a tie count is a property of the scene and not of
 * whatever rung the governor happened to be on. Tie counts scale with pixel
 * count; a gate that does not pin this grades the ladder.
 */
export const PIN_PROBE_RESOLUTION = (ratio = 1) => {
  const r = window.__piratesBR?.renderer;
  if (!r) return false;
  const pinned = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  r.minPixelRatio = pinned;
  r.maxPixelRatio = pinned;
  r.applyPixelRatio(pinned);
  const gl = r.renderer.getContext();
  return {
    ratio: pinned,
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
  };
};

/**
 * DETACH THE POST CHAIN FOR THE WHOLE SESSION, at the tiers that have one.
 *
 * `DEPTH_TIE_CENSUS`'s own `bypassPost` covers the renders it takes. It does not
 * cover the GAME's frames, and those are what make `balanced` and `high`
 * unmeasurable here: the gate waits three real frames after every placement so
 * the warmer can finish, and three frames of MSAA resolve + a five-level
 * UnrealBloom + a graded OutputPass + FXAA on a CPU rasteriser is ten minutes.
 * One census never completed in a thirty-five minute run.
 *
 * Detaching it costs the measurement nothing. The post chain is a deterministic
 * function of the scene render, so it can smear a tie but cannot create one, and
 * everything that DOES differ between tiers for depth purposes — LOD distances,
 * material variants, the shadow pass, the resolution — is untouched.
 *
 * @returns whether a chain was actually detached, so the run can say so.
 */
export const DETACH_POST_CHAIN = () => {
  const R = window.__piratesBR?.renderer;
  if (!R || !R.postFx) return false;
  R.postFx = null;
  return true;
};

/** Place the free camera and bring the world's LOD to where it would arrive. */
export const PLACE_AND_SETTLE = (c) => {
  const g = window.__piratesBR;
  let y = c.y;
  if (y === null || y === undefined) {
    y = (g.sampleGroundY(c.x, c.z) ?? 0) + (c.groundOffset ?? 1.7);
  }
  let yaw = c.yaw ?? 0;
  if (c.aimAt) yaw = Math.atan2(c.aimAt.x - c.x, c.aimAt.z - c.z);
  g.enableFreeCam(c.x, y, c.z, yaw, c.pitch ?? 0);
  if (c.tod !== undefined) g.setDayNightOverride(c.tod);
  g.settleLod();
  return { x: c.x, y, z: c.z, yaw, pitch: c.pitch ?? 0 };
};

/**
 * ONE CENSUS AT ONE POSE. Runs entirely synchronously so no requestAnimationFrame
 * can interleave between the two renders — that is what makes the pair a
 * controlled experiment rather than two photographs of a moving world.
 *
 * @param opts.excludeFarPlaneSky
 *   The sky dome is the one surface in this game placed at EXACTLY the far plane
 *   (SKY_VERT writes gl_Position.z = w) and it depends on `<=` to survive the
 *   cleared depth of 1.0 — Renderer.ts says so in as many words. Flipping it to
 *   `<` blacks the entire sky and reports a quarter of a million ties that are
 *   not ties. It is held at LessEqual in both renders, which costs the probe
 *   only its ability to see a fight between the sky and geometry at 2999.99 m.
 *
 * @param opts.bypassPost
 *   MEASURE THE TIE, NOT THE SMEAR. `balanced` and `high` run the scene through
 *   EffectComposer — MSAA resolve, UnrealBloom, a graded OutputPass, FXAA — and
 *   every one of those spreads a changed pixel into its neighbours. Counting the
 *   PRESENTED frame at those tiers therefore counts a blur kernel, not a depth
 *   test, and no threshold derived from it means anything.
 *
 *   The tie itself happens in the scene render, which is reachable: dropping
 *   `Renderer.postFx` for the duration of the census sends `R.render()` down its
 *   own `renderer.render(scene, camera)` branch. Nothing else about the frame
 *   changes — same materials, same LOD, same shadow pass, same resolution.
 *
 *   The post chain cannot CREATE a tie and it is a deterministic function of its
 *   input, so a scene render with zero changed pixels composes to a presented
 *   frame with zero changed pixels. Measuring before the chain is therefore not
 *   a weaker claim than measuring after it — it is the same claim without the
 *   blur. `presented` reports the after-chain count beside it so the difference
 *   is on the record rather than assumed.
 */
export const DEPTH_TIE_CENSUS = (opts = {}) => {
  const LESS_DEPTH = 2;
  const LESS_EQUAL_DEPTH = 3;
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const bytes = w * h * 4;
  const a = new Uint8Array(bytes);
  const b = new Uint8Array(bytes);
  const c = new Uint8Array(bytes);

  // FREEZE THE WALL CLOCK ACROSS EVERY RENDER THIS CENSUS TAKES.
  //
  // A render in this game ADVANCES ANIMATION: MiscMeshFactory's station halo
  // runs `onBeforeRender = () => animate(performance.now() / 1000)` and CombatFx
  // re-orients its points and impostors in theirs. Those fire once per
  // `renderer.render()`, not once per game frame, so a probe that renders three
  // times photographs three different worlds. Stubbing performance.now freezes
  // anything driven by wall-clock time whether this file knows about it or not,
  // and it is what makes `selfNoise` capable of reading 0 at all.
  const realNow = performance.now.bind(performance);
  const frozenAt = realNow();
  const savedPost = R.postFx ?? null;
  const shoot = (buf) => {
    performance.now = () => frozenAt;
    try {
      R.render();
      renderer.setRenderTarget(null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    } finally {
      performance.now = realNow;
    }
  };

  // Every distinct material in the graph, hidden subtrees included: a material
  // reached only through a `visible === false` node draws nothing this frame and
  // flipping it costs nothing, but skipping the walk into those subtrees would
  // miss a material shared with something that IS drawn.
  const materials = new Set();
  R.scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) { for (const x of m) if (x) materials.add(x); } else materials.add(m);
  });
  const sky = R.skyMaterial ?? null;
  const flippable = [...materials].filter((m) => {
    if (m.depthTest === false) return false;
    if (opts.excludeFarPlaneSky !== false && m === sky) return false;
    const f = m.depthFunc ?? LESS_EQUAL_DEPTH;
    return f === LESS_EQUAL_DEPTH || f === LESS_DEPTH;
  });
  /** Symmetric: calling it twice restores every material exactly. */
  const flip = () => {
    for (const m of flippable) {
      m.depthFunc = m.depthFunc === LESS_EQUAL_DEPTH ? LESS_DEPTH : LESS_EQUAL_DEPTH;
    }
  };

  const countDiff = (x, y, tol) => {
    let n = 0;
    for (let i = 0; i < bytes; i += 4) {
      const dr = Math.abs(x[i] - y[i]);
      const dg = Math.abs(x[i + 1] - y[i + 1]);
      const db = Math.abs(x[i + 2] - y[i + 2]);
      if (dr > tol || dg > tol || db > tol) n += 1;
    }
    return n;
  };

  // ── the composed frame, for the record ─────────────────────────────────
  // Taken FIRST, while the chain is still attached, and reported beside the
  // scene-render count so the smear is a measured number rather than a claim.
  let presented = null;
  if (savedPost && opts.presented) {
    shoot(a);
    shoot(c);
    const noise = countDiff(a, c, 0);
    flip();
    shoot(b);
    flip();
    presented = { selfNoise: noise, ties: countDiff(a, b, 0), tiesLoud: countDiff(a, b, 24) };
  }
  if (opts.bypassPost) R.postFx = null;

  // ── the control: two renders, nothing changed ──────────────────────────
  shoot(a);
  shoot(c);
  const selfNoise = countDiff(a, c, 0);

  // ── the experiment: the same world state under `<` instead of `<=` ─────
  flip();
  shoot(b);
  flip();

  const ties = countDiff(a, b, 0);
  // A tie whose two surfaces differ by a couple of levels is invisible; one
  // whose surfaces differ by 24+ levels is the shimmer a player sees. Both are
  // reported so a gate can be set on the one that matters without pretending
  // the other is not there.
  const tiesVisible = countDiff(a, b, 8);
  const tiesLoud = countDiff(a, b, 24);

  // WHERE. A count says a stand is dirty; a person fixing it needs the pixels.
  // Cluster into a coarse grid so the answer is a handful of regions rather than
  // fifty thousand coordinates, and keep the worst colour pair in each — the two
  // surfaces that are fighting, in the shading they are fighting in.
  const CELL = 24;
  const cols = Math.ceil(w / CELL);
  const cells = new Map();
  const tieMask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < bytes; i += 4, p += 1) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const delta = Math.max(dr, dg, db);
    if (delta === 0) continue;
    tieMask[p] = 1;
    const px = p % w;
    const py = (p / w) | 0;
    const key = ((py / CELL) | 0) * cols + ((px / CELL) | 0);
    let cell = cells.get(key);
    if (!cell) {
      cell = { n: 0, worst: 0, x: 0, y: 0, colA: null, colB: null };
      cells.set(key, cell);
    }
    cell.n += 1;
    cell.x += px;
    cell.y += py;
    if (delta > cell.worst) {
      cell.worst = delta;
      cell.colA = [a[i], a[i + 1], a[i + 2]];
      cell.colB = [b[i], b[i + 1], b[i + 2]];
      // readPixels is bottom-up; report the coordinate a screenshot uses.
      cell.px = px;
      cell.py = h - 1 - py;
    }
  }
  // A COPLANAR FIGHT HAS AN INSIDE; AN INTERSECTION DOES NOT.
  //
  // Not every depth tie is the artifact anyone means by z-fighting. Where two
  // surfaces genuinely CROSS — the ocean meeting a beach or a rock skirt, a
  // waterfall sheet entering its plunge pool, two foliage cards passing through
  // each other — their depths are exactly equal along the intersection curve,
  // by geometry and not by precision. The pierce log for the island overlook is
  // full of exactly that: sea-rock at 340.37 m against ocean-lod-grid at
  // 340.51 m, island-terrain at 87.77 m against ocean-lod-grid at 88.96 m. No
  // depth bias removes those and none should: the surfaces really do meet there.
  //
  // The shimmering kind is different in SHAPE. Two coplanar surfaces tie over an
  // AREA — a decal against the wall it lies on, a merged batch against the piece
  // it duplicates — and the winner reshuffles across that area as the eye moves.
  // An intersection ties along a LINE one or two pixels wide, and no amount of
  // camera movement widens it.
  //
  // So the count that a gate can honestly demand be zero is the count of tie
  // pixels with an INTERIOR: a pixel whose four neighbours are all tied is
  // inside a tied region at least three pixels across. An intersection curve has
  // no such pixel at any length; a coplanar patch is nothing but such pixels.
  // ALL EIGHT NEIGHBOURS, not four. Two intersection curves that CROSS, and a
  // sharp kink in one, both produce a pixel with a tied neighbour on each of the
  // four sides — measured, exactly one such pixel at two of the nine stands,
  // which would have made the gate fail on the shape of a coastline. Requiring
  // the full 3x3 asks for a solid tied block, which a curve of any shape cannot
  // produce and a coplanar patch produces by the hundred.
  let patchPixels = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      if (!tieMask[p]) continue;
      if (tieMask[p - 1] && tieMask[p + 1] && tieMask[p - w] && tieMask[p + w]
        && tieMask[p - w - 1] && tieMask[p - w + 1] && tieMask[p + w - 1] && tieMask[p + w + 1]) {
        patchPixels += 1;
      }
    }
  }

  const clusters = [...cells.values()]
    .sort((p, q) => q.n - p.n)
    .slice(0, 12)
    .map((cell) => ({
      pixels: cell.n,
      worstDelta: cell.worst,
      x: cell.px,
      y: cell.py,
      colA: cell.colA,
      colB: cell.colB,
    }));

  // THE PICTURE, WITH THE FIGHT PAINTED ON IT. Composed here from the probe's
  // OWN readback rather than from the canvas: by the time a screenshot could be
  // taken the game's next rAF has already drawn a different frame over it.
  let maskPng = null;
  if (opts.mask && ties > 0) {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0, p = 0; i < bytes; i += 4, p += 1) {
      const px = p % w;
      const py = (p / w) | 0;
      // readPixels is bottom-up; ImageData is top-down.
      const q = (((h - 1 - py) * w) + px) * 4;
      const delta = Math.max(
        Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]),
      );
      if (delta === 0) {
        img.data[q] = a[i] >> 1;
        img.data[q + 1] = a[i + 1] >> 1;
        img.data[q + 2] = a[i + 2] >> 1;
      } else {
        img.data[q] = 255;
        img.data[q + 1] = 0;
        img.data[q + 2] = delta > 24 ? 0 : 200;
      }
      img.data[q + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    maskPng = out.toDataURL('image/png');
  }

  R.postFx = savedPost;

  return {
    width: w,
    height: h,
    pixels: w * h,
    postBypassed: !!(opts.bypassPost && savedPost),
    presented,
    selfNoise,
    ties,
    patchPixels,
    tiesVisible,
    tiesLoud,
    materialsFlipped: flippable.length,
    materialsSeen: materials.size,
    clusters,
    maskPng,
  };
};

/**
 * WHAT IS FIGHTING, BY NAME. Casts a ray through a tie pixel and reports the
 * surfaces it pierces in depth order — a pair of hits a few millimetres apart at
 * a tie pixel names the two surfaces in the fight, which is the only thing a
 * count cannot tell you and the only thing a fix needs.
 */
export const PIERCE_TIE_PIXELS = async (points) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__piratesBR;
  const camera = g.renderer.camera;
  const scene = g.renderer.scene;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  ray.far = 4000;
  const named = (o) => {
    for (let c = o; c; c = c.parent) if (c.name) return c.name;
    return o.type;
  };
  const out = [];
  for (const p of points) {
    const ndc = new THREE.Vector2(
      (p.x / p.width) * 2 - 1,
      -((p.y / p.height) * 2 - 1),
    );
    ray.setFromCamera(ndc, camera);
    let hits = [];
    try { hits = ray.intersectObject(scene, true); } catch { hits = []; }
    out.push({
      x: p.x,
      y: p.y,
      hits: hits.slice(0, 6).map((hit) => ({
        distance: Number(hit.distance.toFixed(4)),
        object: hit.object.name || hit.object.type,
        owner: named(hit.object),
        material: hit.object.material?.name || hit.object.material?.type || null,
      })),
    });
  }
  return out;
};
