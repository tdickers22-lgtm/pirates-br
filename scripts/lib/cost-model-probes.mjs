// IN-PAGE INSTRUMENTS FOR THE FRAME COST MODEL.
//
// Everything here is a plain page-function with no side effect on import, in
// the same spirit as lib/perf-scenes.mjs: the census rig and the scaling rig
// must measure with the SAME instrument or their numbers cannot be compared.
//
// WHAT IS EXACT AND WHAT IS NOT, on the software rasteriser this repo is
// limited to (see lib/browser-args.mjs):
//
//   EXACT   draw calls, triangles, programs, geometry/texture residency and
//           bytes, render-target sizes, shadow-pass and post-pass draw splits,
//           and — the new one — DEPTH COMPLEXITY, because it is counted in the
//           stencil buffer by the rasteriser itself, one increment per fragment
//           that survives the depth test. None of those know which backend is
//           underneath.
//   REAL SHAPE, ADVISORY MAGNITUDE   frame milliseconds, the ordering of a CPU
//           profile's self time, the fact that a stall is one frame or many.
//   MEANINGLESS   absolute ms as a prediction of a real GPU.
//
// HOW THE OVERDRAW COUNT WORKS, and why it is not a material swap.
//
// The obvious way to count overdraw is to swap every material for an additive
// one that writes 1/255 and read the colour back. It is also wrong here: this
// scene is full of ShaderMaterials whose VERTEX stage decides where the pixels
// land (ocean displacement, foliage wind, per-particle point size) and whose
// FRAGMENT stage decides whether they land at all (alpha cutouts on every leaf
// and every rain streak). Replace the material and you have measured a
// different scene — bigger where the cutouts were, differently shaped where the
// displacement was.
//
// So nothing is replaced. The materials keep their own shaders and only their
// STENCIL state is touched: write on, func ALWAYS, z-pass INCR_WRAP. Every
// fragment that survives its own alpha test and the depth test increments the
// stencil by one, and the pixel's stencil value ends the frame equal to its
// depth complexity. That value is then read out with K full-screen quads whose
// stencil test is `k <= stencil`, each adding 1/255 to the colour: after K
// passes the red channel holds min(depthComplexity, K)/255, and one readPixels
// gives the whole histogram. The quads are ShaderMaterial on purpose — three
// appends tone mapping and the output colour-space transform to built-in
// materials but never to a ShaderMaterial, and either one would turn 1/255 into
// something that is not 1/255.
//
// Per-source attribution uses the same render with stencil WRITE enabled on one
// source's materials only, so the rest of the world still builds the depth
// buffer that occludes it. That costs one scene render per source, which is why
// the driver spends them only on the scenes where the answer changes anything.

/** Load a THREE namespace into the page. Vite serves both of these; the second
 *  is the raw module, used when the dep pre-bundle is not where it usually is.
 *  A second module instance is safe for what this file builds with it — three's
 *  renderer duck-types (`isMesh`, `isWebGLRenderTarget`, …) and never uses
 *  instanceof, and the constants are plain numbers. */
export const LOAD_THREE = async () => {
  if (window.__costThree) return 'cached';
  const candidates = [
    '/node_modules/.vite/deps/three.js',
    '/node_modules/three/build/three.module.js',
  ];
  for (const path of candidates) {
    try {
      const mod = await import(path);
      if (mod?.Scene && mod?.ShaderMaterial) { window.__costThree = mod; return path; }
    } catch { /* try the next */ }
  }
  return null;
};

/**
 * THE SOURCE BUCKET a drawable belongs to.
 *
 * Same keying as lib/perf-scenes.mjs TALLY_DRAW_SOURCES — the report has to read
 * as a list of modules, not of meshes — with the blended layers this model is
 * about split out finely enough to act on: rain and the storm curtain are not
 * "environment", and a waterfall's sheet is not its mist.
 *
 * Written as a STRING so it can be injected into other page functions, which
 * are serialised standalone and cannot close over an import.
 */
export const BUCKET_FN = `
function makeBucket(scene) {
  return function bucketFor(node) {
    for (let c = node; c; c = c.parent) {
      const n = c.name;
      if (!n) continue;
      if (n === 'island-micro-root') return 'island-micro';
      if (n.startsWith('rain') || n.startsWith('storm-rain')) return 'fx-rain';
      if (n.startsWith('storm')) return 'fx-storm-curtain';
      if (n.startsWith('foam') || n.startsWith('wake') || n.startsWith('spray')) return 'fx-foam-wake';
      if (n.startsWith('waterfall-mist') || n.startsWith('mist')) return 'fx-mist';
      if (n.startsWith('waterfall')) return 'waterfall';
      if (n.startsWith('glow') || n.startsWith('lantern') || n.startsWith('flame') || n.startsWith('torch')) return 'fx-glow';
      if (n.startsWith('geyser') || n.startsWith('steam') || n.startsWith('smoke') || n.startsWith('ember')) return 'fx-volcanic';
      if (n.startsWith('island-') && n !== 'island-detail-root') return n;
      if (n.startsWith('decor-')) return 'island-decor';
      if (n.startsWith('cave')) return 'cave';
      if (n.startsWith('ship') || n.startsWith('hull')) return 'ship';
      if (n.startsWith('sea-rock')) return 'sea-rock';
      if (n === 'environment') break;
    }
    // Nothing named it. A tag written by TAG_BUCKETS names the FIELD that owns
    // it, which is the only thing that tells the anonymous groups the FX systems
    // add straight to the scene apart from one another.
    for (let c = node; c; c = c.parent) {
      if (c.userData && c.userData.__costBucket) return c.userData.__costBucket;
    }
    for (let c = node; c; c = c.parent) {
      if (c.parent === scene && c.name) return c.name;
    }
    // Last resort: at least say what KIND of thing went uncounted, so a bucket
    // called "anon" can never quietly hold the answer.
    const mat = Array.isArray(node.material) ? node.material[0] : node.material;
    return 'anon:' + (node.type || '?') + '/' + (mat?.type || '?');
  };
}
`;

/**
 * NAME THE ANONYMOUS SCENE.
 *
 * Most of what this game blends is added to the scene as an unnamed Group,
 * Sprite or InstancedMesh — 119 sprites and a 96 m haze cylinder under
 * `(Scene)/(Group)`, none of which a name-keyed bucket can tell apart. But every
 * one of them is HELD IN A FIELD by the system that made it, and the debug
 * object is the live Game, so those fields are reachable: `envFx.rainHaze`,
 * `envFx.stormFront`, `combatFx.<pool>`, `renderer.skyMesh`. This walks the
 * object graph a few levels deep and writes the field path onto each Object3D's
 * userData, which the bucket function then prefers over any name.
 *
 * userData ONLY — nothing about the scene, its materials or its visibility is
 * touched, so a tagged world renders exactly as an untagged one does.
 */
export const TAG_BUCKETS = ({ maxDepth = 3 } = {}) => {
  const g = window.__piratesBR;
  const scene = g.renderer.scene;

  const inScene = new Set();
  scene.traverse((o) => inScene.add(o));

  const seen = new Set();
  let tagged = 0;
  const visit = (obj, path, depth) => {
    if (!obj || depth > maxDepth || seen.has(obj)) return;
    if (typeof obj !== 'object') return;
    seen.add(obj);

    if (obj.isObject3D) {
      if (inScene.has(obj) && obj !== scene) {
        obj.userData = obj.userData || {};
        if (!obj.userData.__costBucket) { obj.userData.__costBucket = path; tagged += 1; }
      }
      return; // never descend a scene graph by field — .children is the graph
    }
    if (obj instanceof Map) {
      // The KEY is dropped on purpose. These maps are entity-id keyed, and a
      // bucket per chest is not attribution, it is noise that pushes the ocean
      // and the sky off the end of the table.
      let i = 0;
      for (const v of obj.values()) { visit(v, `${path}[]`, depth + 1); if (++i > 64) break; }
      return;
    }
    if (obj instanceof Set) {
      let i = 0;
      for (const v of obj) { visit(v, `${path}[]`, depth + 1); if (++i > 64) break; }
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 128); i++) visit(obj[i], `${path}[]`, depth + 1);
      return;
    }
    if (obj instanceof HTMLElement || obj instanceof WebGLRenderingContext) return;

    let keys;
    try { keys = Object.getOwnPropertyNames(obj); } catch { return; }
    for (const k of keys) {
      if (k.startsWith('_')) continue;
      let v;
      try { v = obj[k]; } catch { continue; }
      if (!v || typeof v !== 'object') continue;
      visit(v, depth === 0 ? k : `${path}.${k}`, depth + 1);
    }
  };
  visit(g, 'game', 0);

  // How much of the frame is still nameless after tagging — the honesty check on
  // the attribution table below it.
  let untagged = 0, total = 0;
  scene.traverse((o) => {
    if (!(o.isMesh || o.isPoints || o.isSprite || o.isLine)) return;
    total += 1;
    let has = false;
    for (let c = o; c; c = c.parent) { if (c.userData?.__costBucket || c.name) { has = true; break; } }
    if (!has) untagged += 1;
  });
  return { tagged, drawables: total, stillAnonymous: untagged };
};

/** Frustum planes for the live camera, built by hand so no THREE import is
 *  needed inside a page function that only wants to cull. */
export const FRUSTUM_FN = `
function viewProjection(camera) {
  // matrixWorldInverse is refreshed by WebGLRenderer.render, so it is only as
  // current as the last frame; a probe that placed the camera itself must not
  // inherit the previous view.
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
}
function makePlanes(camera) {
  const m = viewProjection(camera);
  const e = m.elements;
  const planes = [];
  const push = (a, b, c, d) => { const len = Math.hypot(a, b, c) || 1; planes.push([a/len, b/len, c/len, d/len]); };
  push(e[3]-e[0], e[7]-e[4], e[11]-e[8], e[15]-e[12]);
  push(e[3]+e[0], e[7]+e[4], e[11]+e[8], e[15]+e[12]);
  push(e[3]+e[1], e[7]+e[5], e[11]+e[9], e[15]+e[13]);
  push(e[3]-e[1], e[7]-e[5], e[11]-e[9], e[15]-e[13]);
  push(e[3]-e[2], e[7]-e[6], e[11]-e[10], e[15]-e[14]);
  push(e[3]+e[2], e[7]+e[6], e[11]+e[10], e[15]+e[14]);
  return planes;
}
function inFrustum(mesh, planes) {
  const geo = mesh.geometry;
  if (!geo) return true;
  if (!geo.boundingSphere) { try { geo.computeBoundingSphere(); } catch { return true; } }
  const bs = geo.boundingSphere;
  if (!bs) return true;
  const c = bs.center.clone().applyMatrix4(mesh.matrixWorld);
  const el = mesh.matrixWorld.elements;
  const scale = Math.sqrt(Math.max(
    el[0]*el[0]+el[1]*el[1]+el[2]*el[2],
    el[4]*el[4]+el[5]*el[5]+el[6]*el[6],
    el[8]*el[8]+el[9]*el[9]+el[10]*el[10],
  ));
  const r = bs.radius * scale;
  for (const p of planes) { if (p[0]*c.x + p[1]*c.y + p[2]*c.z + p[3] < -r) return false; }
  return true;
}
`;

/** Is this material one the GPU has to BLEND rather than replace? Anything that
 *  blends, or that refuses to write depth, pays fill for every layer of itself
 *  the camera can see through — which is the whole subject of the overdraw
 *  census. NormalBlending + transparent=false + depthWrite=true is the only
 *  combination that does not. */
export const BLENDED_FN = `
function isBlended(mat) {
  if (!mat) return false;
  if (mat.transparent === true) return true;
  if (mat.blending !== undefined && mat.blending !== 1 /* NormalBlending */) return true;
  if (mat.depthWrite === false) return true;
  return false;
}
`;

/**
 * WHAT THE FRAME IS MADE OF, without rendering anything.
 *
 * Walks the live scene the way three's renderer does — visible, in the frustum,
 * an InstancedMesh counted as the one call it is — and reports, per source
 * bucket: draw calls, triangles, how many of those calls BLEND, and the
 * blended layers' projected screen coverage.
 *
 * The coverage figure is an analytic upper bound, not a measurement: a mesh's
 * bounding box is projected to NDC, clipped to the viewport, and its area taken
 * as a fraction of the screen. For the things that actually matter here — the
 * ocean shell, the sky dome, a storm curtain, a rain box, waterfall sheets,
 * full-screen overlays — a box is very nearly the shape of the thing, so the
 * bound is tight. For a sparse particle cloud it is loose by a lot, which is
 * exactly why the stencil census below exists to correct it.
 */
export const FRAME_INVENTORY = () => {
  const g = window.__piratesBR;
  const R = g.renderer;
  const camera = R.camera;
  const scene = R.scene;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

  const bucketFor = makeBucket(scene);
  const planes = makePlanes(camera);
  const vp = viewProjection(camera);

  /** Screen-area fraction of a drawable's world bounding box, clipped to the
   *  viewport. Returns 1 when any corner is behind the near plane and the box
   *  straddles the camera (a shell the camera is INSIDE — sky, ocean, a storm
   *  curtain — covers the screen and its projected corners are meaningless). */
  const coverage = (mesh) => {
    const geo = mesh.geometry;
    if (!geo) return 0;
    if (!geo.boundingBox) { try { geo.computeBoundingBox(); } catch { return 0; } }
    const bb = geo.boundingBox;
    if (!bb) return 0;
    let behind = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const m = mesh.matrixWorld.elements;
    const e = vp.elements;
    for (let i = 0; i < 8; i++) {
      const lx = (i & 1) ? bb.max.x : bb.min.x;
      const ly = (i & 2) ? bb.max.y : bb.min.y;
      const lz = (i & 4) ? bb.max.z : bb.min.z;
      const wx = m[0]*lx + m[4]*ly + m[8]*lz + m[12];
      const wy = m[1]*lx + m[5]*ly + m[9]*lz + m[13];
      const wz = m[2]*lx + m[6]*ly + m[10]*lz + m[14];
      const cw = e[3]*wx + e[7]*wy + e[11]*wz + e[15];
      if (cw <= 1e-4) { behind++; continue; }
      const cx = (e[0]*wx + e[4]*wy + e[8]*wz + e[12]) / cw;
      const cy = (e[1]*wx + e[5]*wy + e[9]*wz + e[13]) / cw;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    }
    if (behind === 8) return 0;
    if (behind > 0) return 1; // camera inside / straddling: it fills the view
    const w = Math.min(1, maxX) - Math.max(-1, minX);
    const h = Math.min(1, maxY) - Math.max(-1, minY);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / 4;
  };

  const tally = {};
  const walk = (node) => {
    if (!node.visible) return;
    if (node.isMesh || node.isPoints || node.isLine || node.isSprite || node.isInstancedMesh) {
      const drawn = node.frustumCulled === false || inFrustum(node, planes);
      if (drawn) {
        const groups = node.geometry?.groups ?? [];
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        const calls = Array.isArray(node.material) && groups.length > 0 ? groups.length : 1;
        const key = bucketFor(node);
        const t = (tally[key] ??= {
          calls: 0, meshes: 0, tris: 0, blendedCalls: 0, blendedMeshes: 0,
          coverage: 0, points: 0, sprites: 0, instances: 0,
        });
        t.calls += calls;
        t.meshes += 1;
        const geo = node.geometry;
        if (geo) {
          const idx = geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0);
          const inst = node.isInstancedMesh ? (node.count ?? 1) : 1;
          if (node.isMesh || node.isInstancedMesh) t.tris += (idx / 3) * inst;
          if (node.isInstancedMesh) t.instances += inst;
          if (node.isPoints) t.points += geo.attributes.position?.count ?? 0;
        }
        if (node.isSprite) t.sprites += 1;
        const anyBlended = mats.some(isBlended);
        if (anyBlended) {
          t.blendedCalls += calls;
          t.blendedMeshes += 1;
          t.coverage += coverage(node);
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(scene);

  return Object.entries(tally)
    .map(([source, v]) => ({
      source,
      calls: v.calls,
      meshes: v.meshes,
      tris: Math.round(v.tris),
      blendedCalls: v.blendedCalls,
      blendedMeshes: v.blendedMeshes,
      coverage: Math.round(v.coverage * 1000) / 1000,
      points: v.points,
      sprites: v.sprites,
      instances: v.instances,
    }))
    .sort((a, b) => b.calls - a.calls);
};

/**
 * PASS SPLIT — what the shadow map costs, what the main pass costs, and what
 * the post chain costs, in draws and triangles, separately.
 *
 * The game runs with `renderer.info.autoReset = false` so its own overlay can
 * read a whole frame across every pass; that is exactly what makes the three
 * costs indistinguishable from the outside. Each one is therefore driven
 * DIRECTLY here with the counter reset in front of it:
 *
 *   shadow  read off the counter on either side of the renderer's OWN call to
 *           shadowMap.render, by wrapping that method for one frame. Calling
 *           shadowMap.render directly from outside looks like the honest way and
 *           is not: three nulls `_currentRenderState` when a render finishes, so
 *           the first material the shadow pass reaches throws on `state`. The
 *           wrapper measures the real pass, inside the real frame, and is put
 *           back before this function returns.
 *   scene   renderer.render(scene, camera) total, minus the shadow above.
 *   post    composer.render(), which runs both of those plus the chain, so the
 *           chain is that difference again.
 *
 * Nothing here is left changed: the game's next frame resets and re-renders.
 */
export const PASS_SPLIT = () => {
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const info = renderer.info;
  const scene = R.scene;
  const camera = R.camera;
  const sun = R.sun;
  const post = R.postFx ?? null;

  const read = () => ({ calls: info.render.calls, tris: info.render.triangles, points: info.render.points, lines: info.render.lines });

  const wasAuto = info.autoReset;
  info.autoReset = false;

  let shadow = { calls: 0, tris: 0, points: 0, lines: 0 };
  const shadowMap = renderer.shadowMap;
  const origShadowRender = shadowMap.render;
  shadowMap.render = function wrapped(...args) {
    const before = read();
    const out = origShadowRender.apply(this, args);
    const after = read();
    shadow = {
      calls: after.calls - before.calls,
      tris: after.tris - before.tris,
      points: after.points - before.points,
      lines: after.lines - before.lines,
    };
    return out;
  };

  let sceneAndShadow;
  try {
    info.reset();
    renderer.render(scene, camera);
    sceneAndShadow = read();
  } finally {
    shadowMap.render = origShadowRender;
  }

  let composerTotal = null;
  if (post?.composer) {
    info.reset();
    try { post.composer.render(); composerTotal = read(); } catch { composerTotal = null; }
  }

  info.reset();
  info.autoReset = wasAuto;

  const main = {
    calls: sceneAndShadow.calls - shadow.calls,
    tris: sceneAndShadow.tris - shadow.tris,
  };
  const postPass = composerTotal
    ? { calls: composerTotal.calls - sceneAndShadow.calls, tris: composerTotal.tris - sceneAndShadow.tris }
    : { calls: 0, tris: 0 };

  // The post chain's real cost is FILL, not draws: every pass is a quad over a
  // known render target. Enumerate the targets so the model can price it.
  const rts = [];
  const seen = new Set();
  const addRt = (label, rt) => {
    if (!rt || seen.has(rt)) return;
    seen.add(rt);
    const w = rt.width ?? 0, h = rt.height ?? 0;
    rts.push({
      label,
      width: w, height: h, pixels: w * h,
      samples: rt.samples ?? 0,
      type: rt.texture?.type ?? null,
      count: rt.texture?.isDataArrayTexture ? (rt.depth ?? 1) : 1,
    });
  };
  const passNames = [];
  if (post?.composer) {
    addRt('composer.renderTarget1', post.composer.renderTarget1);
    addRt('composer.renderTarget2', post.composer.renderTarget2);
    for (const pass of post.composer.passes ?? []) {
      const name = pass.constructor?.name ?? 'Pass';
      passNames.push(name);
      for (const key of Object.keys(pass)) {
        const v = pass[key];
        if (v && v.isWebGLRenderTarget) addRt(`${name}.${key}`, v);
        else if (Array.isArray(v)) v.forEach((x, i) => { if (x && x.isWebGLRenderTarget) addRt(`${name}.${key}[${i}]`, x); });
      }
    }
  }
  if (sun?.shadow?.map) {
    addRt('sun.shadow.map', sun.shadow.map);
  }

  const gl = renderer.getContext();
  const bw = gl.drawingBufferWidth;
  const bh = gl.drawingBufferHeight;

  return {
    shadow,
    main,
    post: postPass,
    passNames,
    renderTargets: rts,
    drawingBuffer: { width: bw, height: bh, pixels: bw * bh },
    stencilBits: gl.getParameter(gl.STENCIL_BITS),
    pixelRatio: renderer.getPixelRatio(),
    shadowMapSize: sun?.shadow?.mapSize ? { x: sun.shadow.mapSize.x, y: sun.shadow.mapSize.y } : null,
    shadowsEnabled: !!renderer.shadowMap.enabled,
  };
};

/**
 * RESIDENT BYTES — what the GPU is holding, not just how many objects.
 *
 * renderer.info.memory counts geometries and textures; it never says how big
 * they are, and "412 textures" is not a number anyone can act on. This walks
 * every material reachable from the scene plus the render targets and totals
 * the actual byte cost, attributed by source bucket for the geometry side and
 * by name/size for the texture side.
 */
export const RESOURCE_CENSUS = () => {
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const scene = R.scene;

  const bucketFor = makeBucket(scene);

  const texelBytes = (format, type) => {
    // three constants: UnsignedByteType 1009, HalfFloatType 1016, FloatType 1015,
    // UnsignedShort 1005/1006/1007/1008 (depth-ish), RGBAFormat 1023, RGBFormat 1022,
    // RedFormat 1028, RGFormat 1030, DepthFormat 1026, DepthStencilFormat 1027.
    const channels = format === 1028 ? 1 : format === 1030 ? 2 : format === 1022 ? 3 : 4;
    const size = type === 1016 ? 2 : type === 1015 ? 4 : 1;
    if (format === 1026) return 3;
    if (format === 1027) return 4;
    return channels * size;
  };

  const usesMips = (t) => {
    if (!t.generateMipmaps) return false;
    // *MipmapNearestFilter 1004/1005, *MipmapLinearFilter 1007/1008
    return [1004, 1005, 1007, 1008].includes(t.minFilter);
  };

  const texBytes = (t) => {
    if (!t) return 0;
    if (t.isCompressedTexture && Array.isArray(t.mipmaps) && t.mipmaps.length) {
      return t.mipmaps.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0);
    }
    const img = t.image;
    let w = 0, h = 0, layers = 1;
    if (Array.isArray(img)) { w = img[0]?.width ?? 0; h = img[0]?.height ?? 0; layers = img.length; }
    else if (img) { w = img.width ?? img.videoWidth ?? 0; h = img.height ?? img.videoHeight ?? 0; layers = img.depth ?? 1; }
    if (t.isDataTexture && img?.data?.byteLength) {
      let b = img.data.byteLength;
      if (usesMips(t)) b = Math.round(b * 4 / 3);
      return b;
    }
    let bytes = w * h * layers * texelBytes(t.format, t.type);
    if (usesMips(t)) bytes = Math.round(bytes * 4 / 3);
    return bytes;
  };

  const geoBytes = (geo) => {
    if (!geo) return 0;
    let b = 0;
    for (const key of Object.keys(geo.attributes ?? {})) {
      const a = geo.attributes[key];
      if (a?.array?.byteLength) b += a.array.byteLength;
    }
    if (geo.index?.array?.byteLength) b += geo.index.array.byteLength;
    for (const key of Object.keys(geo.morphAttributes ?? {})) {
      for (const a of geo.morphAttributes[key] ?? []) if (a?.array?.byteLength) b += a.array.byteLength;
    }
    return b;
  };

  const seenGeo = new Set();
  const seenTex = new Map(); // texture -> {bytes, w, h, name, users}
  const geoByBucket = {};
  let geoTotal = 0, geoCount = 0;
  let instancedRows = 0;

  const collectTextures = (mat) => {
    if (!mat) return;
    for (const key of Object.keys(mat)) {
      const v = mat[key];
      if (v && v.isTexture) {
        if (!seenTex.has(v)) {
          seenTex.set(v, {
            bytes: texBytes(v), name: v.name || key,
            w: Array.isArray(v.image) ? (v.image[0]?.width ?? 0) : (v.image?.width ?? 0),
            h: Array.isArray(v.image) ? (v.image[0]?.height ?? 0) : (v.image?.height ?? 0),
            slot: key, users: 0,
          });
        }
        seenTex.get(v).users += 1;
      }
    }
    // ShaderMaterial textures hide in uniforms.
    for (const key of Object.keys(mat.uniforms ?? {})) {
      const v = mat.uniforms[key]?.value;
      if (v && v.isTexture) {
        if (!seenTex.has(v)) {
          seenTex.set(v, {
            bytes: texBytes(v), name: v.name || key,
            w: Array.isArray(v.image) ? (v.image[0]?.width ?? 0) : (v.image?.width ?? 0),
            h: Array.isArray(v.image) ? (v.image[0]?.height ?? 0) : (v.image?.height ?? 0),
            slot: `uniform:${key}`, users: 0,
          });
        }
        seenTex.get(v).users += 1;
      }
    }
  };

  const matSet = new Set();
  scene.traverse((o) => {
    const geo = o.geometry;
    if (geo && !seenGeo.has(geo)) {
      seenGeo.add(geo);
      const b = geoBytes(geo);
      geoTotal += b;
      geoCount += 1;
      const k = bucketFor(o);
      geoByBucket[k] = (geoByBucket[k] ?? 0) + b;
    }
    if (o.isInstancedMesh) instancedRows += o.count ?? 0;
    const m = o.material;
    if (!m) return;
    for (const mat of (Array.isArray(m) ? m : [m])) { if (mat) { matSet.add(mat); collectTextures(mat); } }
  });

  // Render targets are GPU bytes nothing above sees.
  const rtBytes = [];
  const addRt = (label, rt) => {
    if (!rt) return;
    const w = rt.width ?? 0, h = rt.height ?? 0;
    const samples = Math.max(1, rt.samples ?? 0);
    const colour = w * h * texelBytes(rt.texture?.format ?? 1023, rt.texture?.type ?? 1009) * samples;
    const depth = rt.depthBuffer ? w * h * (rt.stencilBuffer ? 4 : 3) * samples : 0;
    rtBytes.push({ label, width: w, height: h, samples: rt.samples ?? 0, bytes: colour + depth });
  };
  const post = R.postFx ?? null;
  if (post?.composer) {
    addRt('composer.renderTarget1', post.composer.renderTarget1);
    addRt('composer.renderTarget2', post.composer.renderTarget2);
    for (const pass of post.composer.passes ?? []) {
      const name = pass.constructor?.name ?? 'Pass';
      for (const key of Object.keys(pass)) {
        const v = pass[key];
        if (v && v.isWebGLRenderTarget) addRt(`${name}.${key}`, v);
        else if (Array.isArray(v)) v.forEach((x, i) => { if (x && x.isWebGLRenderTarget) addRt(`${name}.${key}[${i}]`, x); });
      }
    }
  }
  if (R.sun?.shadow?.map) addRt('sun.shadow.map', R.sun.shadow.map);

  const textures = [...seenTex.values()].sort((a, b) => b.bytes - a.bytes);
  const texTotal = textures.reduce((s, t) => s + t.bytes, 0);

  return {
    info: {
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    },
    geometry: {
      count: geoCount,
      bytes: geoTotal,
      instancedRows,
      byBucket: Object.entries(geoByBucket).sort((a, b) => b[1] - a[1]).slice(0, 18)
        .map(([k, v]) => ({ bucket: k, bytes: v })),
    },
    textures: {
      count: textures.length,
      bytes: texTotal,
      top: textures.slice(0, 18),
    },
    materials: matSet.size,
    renderTargets: { list: rtBytes, bytes: rtBytes.reduce((s, r) => s + r.bytes, 0) },
  };
};

/**
 * DEPTH COMPLEXITY, counted by the rasteriser.
 *
 * See the file header for why this is a stencil count and not a material swap.
 * Returns, for the whole frame and for the blended layers alone:
 *   meanAll      average layers over every pixel of the framebuffer
 *   meanCovered  average over pixels that anything touched
 *   p50/p95/max  the distribution — a mean of 3 with a p95 of 22 is a scene
 *                that hitches when the player looks at one particular thing
 *   histogram    pixels at each layer count, so the fixer can see the shape
 *
 * `only` names a source bucket to enable stencil writes for; everything else
 * still renders (and still occludes), it simply is not counted.
 */
export const STENCIL_OVERDRAW = async ({ maxLayers = 24, only = null, blendedOnly = false, preArmed = false }) => {
  const THREE = window.__costThree;
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const scene = R.scene;
  const camera = R.camera;
  const gl = renderer.getContext();
  if (!THREE) throw new Error('THREE not loaded into the page (call LOAD_THREE first)');

  const bucketFor = makeBucket(scene);

  // Which materials get to increment. A material shared by two buckets would be
  // attributed to both, so that is reported rather than hidden.
  const wanted = new Set();
  const matBuckets = new Map();
  scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    const bucket = bucketFor(o);
    for (const mat of (Array.isArray(m) ? m : [m])) {
      if (!mat) continue;
      let set = matBuckets.get(mat);
      if (!set) { set = new Set(); matBuckets.set(mat, set); }
      set.add(bucket);
      const bucketOk = only === null || bucket === only;
      const blendOk = !blendedOnly || isBlended(mat);
      if (bucketOk && blendOk) wanted.add(mat);
    }
  });
  let sharedMaterials = 0;
  for (const set of matBuckets.values()) if (set.size > 1) sharedMaterials += 1;

  // ── arm the stencil on the wanted materials, remember everything ──────────
  // `preArmed` hands that job to the caller: SKY_OCCLUSION needs the stencil on
  // ONE material while everything else keeps rendering, and it also needs to flip
  // that material's depth test, which is a decision only it can make.
  const saved = new Map();
  for (const mat of (preArmed ? [] : matBuckets.keys())) {
    saved.set(mat, {
      w: mat.stencilWrite, f: mat.stencilFunc, r: mat.stencilRef,
      fm: mat.stencilFuncMask, wm: mat.stencilWriteMask,
      sf: mat.stencilFail, zf: mat.stencilZFail, zp: mat.stencilZPass,
    });
    if (wanted.has(mat)) {
      mat.stencilWrite = true;
      mat.stencilFunc = THREE.AlwaysStencilFunc;
      mat.stencilRef = 0;
      mat.stencilFuncMask = 0xff;
      mat.stencilWriteMask = 0xff;
      mat.stencilFail = THREE.KeepStencilOp;
      mat.stencilZFail = THREE.KeepStencilOp;
      mat.stencilZPass = THREE.IncrementWrapStencilOp;
    } else {
      mat.stencilWrite = false;
    }
  }

  // ── the read-out quads: k = 1..K, each passing where stencil >= k ─────────
  const quadScene = window.__costQuadScene ?? (window.__costQuadScene = new THREE.Scene());
  let quad = window.__costQuad;
  if (!quad) {
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      // Deliberately a ShaderMaterial: three appends tone mapping and the
      // output colour-space transform to its built-in materials and never to
      // this, and either one would make 1/255 stop being 1/255.
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(1.0/255.0, 0.0, 0.0, 0.0); }',
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      stencilWrite: true, // in three this enables the stencil TEST as well
      stencilFunc: THREE.LessEqualStencilFunc,
      stencilRef: 1,
      stencilFuncMask: 0xff,
      stencilWriteMask: 0x00,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    quad = new THREE.Mesh(geo, mat);
    quad.frustumCulled = false;
    quadScene.add(quad);
    window.__costQuad = quad;
    window.__costQuadCam = new THREE.Camera();
  }
  const quadCam = window.__costQuadCam;

  const prevAutoClear = renderer.autoClear;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  const infoAuto = renderer.info.autoReset;

  let out;
  try {
    renderer.setRenderTarget(null);
    renderer.info.autoReset = false;

    // 1. the real frame — colour, depth, and now a stencil count per pixel
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = true;
    renderer.info.reset();
    renderer.render(scene, camera);
    const sceneDraws = renderer.info.render.calls;
    const sceneTris = renderer.info.render.triangles;

    // 2. wipe the colour ONLY, so the stencil survives into the read-out
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);

    // 3. K quads, each adding 1/255 where stencil >= k
    for (let k = 1; k <= maxLayers; k++) {
      quad.material.stencilRef = k;
      renderer.render(quadScene, quadCam);
    }

    // 4. one readback carries the whole histogram
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    const hist = new Array(maxLayers + 1).fill(0);
    let sum = 0, covered = 0, max = 0;
    for (let i = 0; i < w * h; i++) {
      const v = buf[i * 4];
      hist[Math.min(v, maxLayers)] += 1;
      sum += v;
      if (v > 0) covered += 1;
      if (v > max) max = v;
    }
    const total = w * h;
    const pct = (p) => {
      let acc = 0;
      const want = total * p;
      for (let k = 0; k <= maxLayers; k++) { acc += hist[k]; if (acc >= want) return k; }
      return maxLayers;
    };

    out = {
      only, blendedOnly,
      width: w, height: h, pixels: total,
      sceneDraws, sceneTris,
      countedMaterials: wanted.size,
      totalMaterials: matBuckets.size,
      sharedMaterials,
      layerSum: sum,
      meanAll: sum / total,
      meanCovered: covered > 0 ? sum / covered : 0,
      coveredFraction: covered / total,
      p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99),
      max,
      histogram: hist,
      saturated: max >= maxLayers,
    };
  } finally {
    for (const [mat, s] of saved) {
      mat.stencilWrite = s.w; mat.stencilFunc = s.f; mat.stencilRef = s.r;
      mat.stencilFuncMask = s.fm; mat.stencilWriteMask = s.wm;
      mat.stencilFail = s.sf; mat.stencilZFail = s.zf; mat.stencilZPass = s.zp;
    }
    renderer.setClearColor(prevClear, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
    renderer.info.reset();
    renderer.info.autoReset = infoAuto;
  }
  return out;
};

/**
 * HOW MUCH OF THE SKY THE PLAYER CANNOT SEE.
 *
 * The sky dome is built with `depthTest: false, depthWrite: false` and
 * `renderOrder = -1`, so it is the first thing drawn and nothing can reject it:
 * the overdraw census reads exactly 1.000 layers over 100% of the framebuffer in
 * every scene, at both tiers, forever. Half of that — or more, on a deck or in a
 * cave — is a procedural sky shader run on pixels the ocean and the islands are
 * about to paint over.
 *
 * "Or more" is not a measurement, so this takes one. The dome is flipped to
 * depth-tested and sorted LAST for a single frame, its stencil armed, and the
 * pixels it still reaches are counted. That fraction is what the sky would cost
 * if it were drawn like every other opaque thing in the scene; 1 minus it is
 * what the current arrangement throws away.
 *
 * depthTest and renderOrder are state, not program keys — nothing re-links — and
 * both are put back before this returns.
 */
export const SKY_OCCLUSION = async ({ maxLayers = 4 } = {}) => {
  const THREE = window.__costThree;
  const g = window.__piratesBR;
  const R = g.renderer;
  const renderer = R.renderer;
  const scene = R.scene;
  const camera = R.camera;
  const gl = renderer.getContext();
  const sky = R.skyMesh;
  if (!sky) throw new Error('no skyMesh on the renderer');

  const mats = [];
  scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mat of (Array.isArray(m) ? m : [m])) if (mat) mats.push(mat);
  });
  const saved = new Map();
  for (const mat of mats) {
    if (saved.has(mat)) continue;
    saved.set(mat, { w: mat.stencilWrite, zp: mat.stencilZPass, f: mat.stencilFunc, wm: mat.stencilWriteMask, fm: mat.stencilFuncMask, dt: mat.depthTest });
    mat.stencilWrite = false;
  }
  const skyMat = Array.isArray(sky.material) ? sky.material[0] : sky.material;
  const skyOrder = sky.renderOrder;
  const skyDepthTest = skyMat.depthTest;

  const out = {};
  try {
    const run = async (label) => {
      skyMat.stencilWrite = true;
      skyMat.stencilFunc = THREE.AlwaysStencilFunc;
      skyMat.stencilRef = 0;
      skyMat.stencilFuncMask = 0xff;
      skyMat.stencilWriteMask = 0xff;
      skyMat.stencilFail = THREE.KeepStencilOp;
      skyMat.stencilZFail = THREE.KeepStencilOp;
      skyMat.stencilZPass = THREE.IncrementWrapStencilOp;
      // preArmed: the census must NOT re-arm every material in the scene. Getting
      // this option name wrong is silent and total — the reading comes back as
      // "the sky covers 100% either way", which is the whole world's stencil
      // count wearing the sky's label.
      const r = await window.__cost.stencilOverdraw({ maxLayers, only: null, blendedOnly: false, preArmed: true });
      out[label] = { coveredFraction: r.coveredFraction, meanAll: r.meanAll };
      skyMat.stencilWrite = false;
    };
    // As it ships: first, depth-test off, unrejectable.
    await run('asShipped');
    // As it would be if it were drawn like anything else.
    skyMat.depthTest = true;
    sky.renderOrder = 100000;
    await run('depthTestedLast');
  } finally {
    skyMat.depthTest = skyDepthTest;
    sky.renderOrder = skyOrder;
    for (const [mat, s] of saved) {
      mat.stencilWrite = s.w; mat.stencilZPass = s.zp; mat.stencilFunc = s.f;
      mat.stencilWriteMask = s.wm; mat.stencilFuncMask = s.fm; mat.depthTest = s.dt;
    }
  }
  const px = gl.drawingBufferWidth * gl.drawingBufferHeight;
  return {
    pixels: px,
    shippedCoverage: out.asShipped?.coveredFraction ?? null,
    depthTestedCoverage: out.depthTestedLast?.coveredFraction ?? null,
    wastedFraction: (out.asShipped?.coveredFraction ?? 0) - (out.depthTestedLast?.coveredFraction ?? 0),
    wastedFragments: Math.round(px * ((out.asShipped?.coveredFraction ?? 0) - (out.depthTestedLast?.coveredFraction ?? 0))),
  };
};

/**
 * TIME A FIXED NUMBER OF FRAMES, not a fixed number of seconds.
 *
 * Every timing rig in this repo captures for N milliseconds, which is right when
 * a frame is 16 ms and useless when it is nine seconds: at pixel ratio 1.5 on a
 * CPU rasteriser a 2,500 ms capture is ONE frame, and the "median" is that one
 * frame. A pixel-ratio sweep is precisely the measurement where the frame time
 * changes by 4x across the sweep, so it has to be counted in frames.
 */
export const TIME_FRAMES = async ({ warmFrames = 3, frames = 6 }) => {
  const g = window.__piratesBR;
  const info = g.renderer.renderer.info;
  const gl = g.renderer.renderer.getContext();
  const dts = [];
  let draws = 0, tris = 0, n = 0;
  await new Promise((resolve) => {
    let i = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      i += 1;
      if (i > warmFrames) {
        dts.push(dt);
        draws += info.render.calls; tris += info.render.triangles; n += 1;
      }
      if (i >= warmFrames + frames) { resolve(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  dts.sort((a, b) => a - b);
  return {
    frames: dts.length,
    medianMs: dts[Math.floor(dts.length / 2)] ?? 0,
    minMs: dts[0] ?? 0,
    maxMs: dts[dts.length - 1] ?? 0,
    draws: n ? draws / n : 0,
    tris: n ? tris / n : 0,
    pixelRatio: g.renderer.renderer.getPixelRatio(),
    fragments: gl.drawingBufferWidth * gl.drawingBufferHeight,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  };
};

/**
 * WHAT IS IN THE FRUSTUM, counted rather than rendered.
 *
 * A scaling law needs many samples, and on a software rasteriser a rendered
 * sample costs seconds. Every count this needs — islands, ships, props, draws,
 * triangles — is decided by the scene graph and the frustum, so it can be taken
 * from a scene-graph walk after settleLod with no frame drawn at all. That is
 * what makes a 36-step yaw sweep affordable, and a coefficient measured over 36
 * stands is worth more than one measured over two.
 */
export const FRUSTUM_ENTITIES = ({ x, y, z, yaw, pitch = -0.05, settle = 2 }) => {
  const g = window.__piratesBR;
  g.enableFreeCam(x, y, z, yaw, pitch);
  g.settleLod(settle);
  const scene = g.renderer.scene;
  const camera = g.renderer.camera;
  const planes = makePlanes(camera);
  const bucketFor = makeBucket(scene);

  let calls = 0, tris = 0, meshes = 0, blendedCalls = 0, instances = 0;
  const islandsSeen = new Set();
  const shipsSeen = new Set();
  const walk = (node) => {
    if (!node.visible) return;
    if (node.isMesh || node.isPoints || node.isLine || node.isSprite || node.isInstancedMesh) {
      if (node.frustumCulled === false || inFrustum(node, planes)) {
        const groups = node.geometry?.groups ?? [];
        const c = Array.isArray(node.material) && groups.length > 0 ? groups.length : 1;
        calls += c; meshes += 1;
        const b = bucketFor(node);
        if (b.startsWith('island-') && !b.startsWith('island-decor') && !b.startsWith('island-micro')) islandsSeen.add(b);
        if (b === 'ship' || b.startsWith('ship_')) shipsSeen.add(b);
        const geo = node.geometry;
        if (geo && (node.isMesh || node.isInstancedMesh)) {
          const idx = geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0);
          const inst = node.isInstancedMesh ? (node.count ?? 1) : 1;
          tris += (idx / 3) * inst;
          if (node.isInstancedMesh) instances += inst;
        }
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        if (mats.some(isBlended)) blendedCalls += c;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(scene);

  // World-space truth for the regressors, independent of what got revealed.
  const st = g.state;
  const camPos = camera.position;
  const fwd = { x: -camera.matrixWorld.elements[8], y: -camera.matrixWorld.elements[9], z: -camera.matrixWorld.elements[10] };
  const inCone = (px, pz, pad) => {
    const dx = px - camPos.x, dz = pz - camPos.z;
    const d = Math.hypot(dx, dz) || 1;
    const cos = (dx / d) * fwd.x + (dz / d) * fwd.z;
    // 74 degrees vertical FOV at 16:9 is ~106 horizontal; half-angle ~53 deg.
    return cos > Math.cos((53 * Math.PI) / 180) - pad / d;
  };
  const islandsInCone = (st?.islands ?? []).filter((i) => inCone(i.position.x, i.position.z, i.radius)).length;
  const shipsInCone = (st?.ships ?? []).filter((s) => inCone(s.position.x, s.position.z, 20)).length;
  const playersInCone = (st?.players ?? []).filter((p) => inCone(p.position.x, p.position.z, 2)).length;

  return {
    yaw, calls, tris: Math.round(tris), meshes, blendedCalls, instances,
    islandGroupsDrawn: islandsSeen.size,
    shipGroupsDrawn: shipsSeen.size,
    islandsInCone, shipsInCone, playersInCone,
  };
};

/** Pin the adaptive resolution scaler at an arbitrary ratio — the shipped pin
 *  in perf-probe only ever pins 1, and the scaling sweep needs 0.75/1.25/1.5. */
export const PIN_RATIO_AT = (ratio) => {
  const r = window.__piratesBR?.renderer;
  if (!r) return null;
  r.minPixelRatio = ratio;
  r.maxPixelRatio = ratio;
  r.applyPixelRatio(ratio);
  return {
    asked: ratio,
    got: r.renderer.getPixelRatio(),
    drawingBuffer: [r.renderer.getContext().drawingBufferWidth, r.renderer.getContext().drawingBufferHeight],
  };
};

/** rAF-gap recorder with a floor the caller picks, plus the wall-clock origin
 *  so a gap can be lined up against a CPU profile's sample timeline. */
export const INSTALL_HITCH_SAMPLER = (thresholdMs) => {
  const w = window;
  w.__hitch = {
    threshold: thresholdMs,
    origin: performance.now(),
    timeOrigin: performance.timeOrigin,
    frames: 0,
    gaps: [],
    all: [],
    last: performance.now(),
  };
  const step = () => {
    const now = performance.now();
    const dt = now - w.__hitch.last;
    w.__hitch.last = now;
    w.__hitch.frames += 1;
    if (w.__hitch.all.length < 40000) w.__hitch.all.push(Math.round(dt * 100) / 100);
    if (dt > w.__hitch.threshold) {
      w.__hitch.gaps.push({ endAt: now, startAt: now - dt, ms: dt });
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** How many bytes of JS heap a frame leaves behind. Collects first so the
 *  reading is retention and not garbage (see the repo's own rule about
 *  performance.memory being quantised without --enable-precise-memory-info). */
export const ALLOCATION_RATE = async (frames) => {
  const gc = window.gc;
  const mem = () => performance.memory?.usedJSHeapSize ?? 0;
  const waitFrames = (n) => new Promise((resolve) => {
    let i = 0;
    const step = () => { if (++i >= n) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  if (!gc) return { error: 'window.gc unavailable — launch with --js-flags=--expose-gc' };
  if (!performance.memory) return { error: 'performance.memory unavailable — launch with --enable-precise-memory-info' };

  gc(); gc();
  await waitFrames(2);
  gc(); gc();
  const before = mem();
  const t0 = performance.now();
  await waitFrames(frames);
  const t1 = performance.now();
  const afterRaw = mem();
  gc(); gc();
  const afterCollected = mem();
  return {
    frames,
    elapsedMs: t1 - t0,
    beforeBytes: before,
    afterBytes: afterRaw,
    afterGcBytes: afterCollected,
    // What the frames ALLOCATED (garbage + retention) …
    grossPerFrame: (afterRaw - before) / frames,
    // …and what they KEPT. A large gross with a near-zero net is a GC pause
    // waiting to happen; a large net is a leak.
    netPerFrame: (afterCollected - before) / frames,
  };
};
