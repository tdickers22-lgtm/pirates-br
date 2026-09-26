// In-page measurements of the first-person hands on a REAL frame (b3.2h, characters-11 / liveplay-12).
//
// Both functions are passed to page.evaluate(), so they are self-contained (no imports, no closures) and
// reach three.js only through objects the game already holds (window.__piratesBR, needs ?debug).
//
// fpArmsInPage(): which view hands are drawn right now, whether each carries the character's fp_arms
//   (pirate_fp_arms.glb) or the primitive fallback, and the triangles those arms submit.
//
// handCoverageInPage(): the fraction of the screen the drawn hands cover, measured by the live
//   WebGLRenderer through the live camera: every mesh under a visible view hand goes on layer 31, the
//   camera sees only layer 31, all of it renders as flat white with no depth test against the world (the
//   viewmodel already draws depthTest-off on top), the default framebuffer is read back and the lit
//   pixels are counted. Everything it touches is restored before it returns, and the next game frame
//   overwrites the canvas, so nothing of it is ever seen.

export function fpArmsInPage() {
  const g = window.__piratesBR;
  const vm = g.viewmodel;
  const drawn = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
  const triCount = (root) => {
    let t = 0;
    root?.traverse((m) => {
      if (!m.isMesh) return;
      const geo = m.geometry;
      t += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    });
    return t;
  };
  const hands = [];
  let loadedArms = 0;
  for (const [rootName, root] of [['weapon', vm.localViewWeaponRoot], ['pocket', vm.localViewPocketRoot], ['hands', vm.localViewHandsRoot]]) {
    root.traverse((o) => {
      if (!/^view-hand-(left|right)$/.test(o.name)) return;
      const arm = o.getObjectByName('fp_arms');
      if (arm) loadedArms += 1;
      if (!drawn(o)) return;
      hands.push({ root: rootName, hand: o.name.replace('view-hand-', ''), fpArms: !!arm, tris: arm ? triCount(arm) : triCount(o) });
    });
  }
  return {
    hands,
    loadedArms,
    drawnFpTris: hands.filter((h) => h.fpArms).reduce((s, h) => s + h.tris, 0),
    weaponId: vm.localViewWeaponId ?? null,
    pocketKind: vm.localViewPocketKind ?? null,
  };
}

export function handCoverageInPage() {
  const g = window.__piratesBR;
  const vm = g.viewmodel;
  const r = g.renderer;
  const gl = r.renderer;
  const scene = r.scene;
  const cam = r.camera;
  const LAYER = 31;
  const drawn = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
  const meshes = [];
  for (const root of [vm.localViewWeaponRoot, vm.localViewPocketRoot, vm.localViewHandsRoot]) {
    root.traverse((o) => {
      if (!/^view-hand-(left|right)$/.test(o.name) || !drawn(o)) return;
      o.traverse((m) => { if (m.isMesh && m.visible) meshes.push(m); });
    });
  }
  if (!meshes.length) return { coverage: 0, meshes: 0 };
  // A flat white material built from one the hand already uses (no THREE global in the page).
  const white = meshes[0].material.clone();
  for (const k of ['map', 'normalMap', 'emissiveMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'envMap']) if (k in white) white[k] = null;
  white.vertexColors = false;
  white.transparent = false;
  white.opacity = 1;
  white.depthTest = false;
  white.depthWrite = false;
  white.color?.setRGB(0, 0, 0);
  white.emissive?.setRGB(1, 1, 1);
  if ('emissiveIntensity' in white) white.emissiveIntensity = 1;
  white.needsUpdate = true;

  const saved = {
    layers: meshes.map((m) => m.layers.mask),
    camMask: cam.layers.mask,
    override: scene.overrideMaterial,
    background: scene.background,
    fog: scene.fog,
    target: gl.getRenderTarget(),
    autoClear: gl.autoClear,
    shadowAuto: gl.shadowMap.autoUpdate,
    clearColor: white.emissive.clone(),
    clearAlpha: gl.getClearAlpha(),
  };
  gl.getClearColor(saved.clearColor);
  let lit = 0, total = 0;
  try {
    for (const m of meshes) m.layers.enable(LAYER);
    cam.layers.set(LAYER);
    scene.overrideMaterial = white;
    scene.background = null;
    scene.fog = null;
    gl.shadowMap.autoUpdate = false;
    gl.autoClear = true;
    gl.setRenderTarget(null);
    gl.setClearColor(0x000000, 1);
    gl.render(scene, cam);
    const ctx = gl.getContext();
    const w = ctx.drawingBufferWidth, h = ctx.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    total = w * h;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 40 || px[i + 1] > 40 || px[i + 2] > 40) lit += 1;
  } finally {
    meshes.forEach((m, i) => { m.layers.mask = saved.layers[i]; });
    cam.layers.mask = saved.camMask;
    scene.overrideMaterial = saved.override;
    scene.background = saved.background;
    scene.fog = saved.fog;
    gl.shadowMap.autoUpdate = saved.shadowAuto;
    gl.autoClear = saved.autoClear;
    gl.setClearColor(saved.clearColor, saved.clearAlpha);
    gl.setRenderTarget(saved.target);
    white.dispose();
  }
  return { coverage: total ? lit / total : 0, meshes: meshes.length };
}
