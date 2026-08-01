// Shared in-page probes for every count-grading rig (perf-census, test-perf-budget).
//
// These were born inside perf-census.mjs, which runs a census the moment it is
// imported — so the budget gate could not reuse them without also running a
// census. They live here instead, as plain page-functions with no side effects,
// and both rigs import the SAME instrument. A tripwire measured with a different
// probe from the census that set it is not measuring the same thing.

/** The pixel ratio, tier and shadow map the CLIENT picked for itself, read
 *  before anything pins it. `verdict` says WHICH SIGNAL chose the tier, which is
 *  the only way to tell an auto-detected 'high' from a `?quality=high` one — and
 *  a census that cannot tell those apart cannot report on auto-detection at all. */
export const READ_CLIENT_TIER = () => {
  const r = window.__piratesBR?.renderer;
  if (!r) return null;
  const verdict = r.getQualityVerdict?.() ?? null;
  return {
    quality: r.getQuality?.() ?? r.quality ?? null,
    verdictReason: verdict?.reason ?? null,
    rendererString: verdict?.rendererString ?? null,
    devicePixelRatio: window.devicePixelRatio || 1,
    currentPixelRatio: r.currentPixelRatio ?? null,
    minPixelRatio: r.minPixelRatio ?? null,
    maxPixelRatio: r.maxPixelRatio ?? null,
    rendererPixelRatio: r.renderer?.getPixelRatio?.() ?? null,
    shadowsEnabled: r.areShadowsEnabled?.() ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    cssPixels: window.innerWidth * window.innerHeight,
    // Fragments the client is asking the GPU for, per frame, at this ratio.
    fragments: Math.round(
      window.innerWidth * window.innerHeight
      * Math.pow(r.renderer?.getPixelRatio?.() ?? 1, 2),
    ),
  };
};

/**
 * The tier this machine would land in with NOTHING pinning it.
 *
 * Every measurement session passes `?quality=…` on purpose — a budget graded at
 * whatever tier the runner's machine happens to earn is not a budget. But that
 * makes the session's own tier reading useless as a report on auto-detection,
 * because the URL param wins first. So ask the module directly, in a page that
 * has the client's code but not its URL: the answer is what a player opening the
 * game on THIS machine gets.
 */
export const READ_AUTO_TIER = async () => {
  const mod = await import('/src/client/rendering/QualityPreference.ts');
  // Never let a probe read a tier the SETTINGS panel wrote on a previous run of
  // itself: the point is what the DETECTOR says.
  const stored = mod.loadQualityPreference();
  const ceiling = mod.loadAutoTierCeiling();
  // detectRenderQuality, NOT decideRenderQuality: the latter honours the `?quality=`
  // this very session is pinned with and would report the pin back as a detection.
  const verdict = mod.detectRenderQuality();
  return {
    quality: verdict.quality,
    reason: verdict.reason,
    rendererString: verdict.rendererString,
    storedPreference: stored,
    auditionCeiling: ceiling,
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio || 1,
    airClass: mod.isAirClassGpu(verdict.rendererString, navigator.hardwareConcurrency ?? 4),
  };
};

/** A deck-height look at an island that actually HAS a fall on it. The July
 *  scene table has no such view, and the waterfall sheets/mist were a whole
 *  content wave that therefore never appeared in any budget. */
export const FIND_WATERFALL_ISLAND = () => {
  const g = window.__piratesBR;
  for (const [id, group] of g.islandMeshes ?? []) {
    let site = null;
    group.traverse((o) => { if (!site && o.name === 'waterfall-site') site = o; });
    if (site) {
      const island = g.state.islands.find((i) => i.id === id);
      // The fall's own plunge pool, in island-local coords (WaterfallBuilder
      // bakes its geometry local and records the base in userData).
      const base = site.userData?.base ?? { x: site.position.x, z: site.position.z };
      return {
        id,
        name: island?.name ?? id,
        x: group.position.x,
        z: group.position.z,
        radius: island?.radius ?? 120,
        siteLocalX: base.x,
        siteLocalZ: base.z,
      };
    }
  }
  return null;
};

/** Stand off the fall at deck height, framed the way a player approaching under
 *  sail sees it: 150m out, eye ~6m above the water, looking straight at the site. */
export function planWaterfallDeck(w) {
  const sx = w.x + w.siteLocalX;
  const sz = w.z + w.siteLocalZ;
  const len = Math.hypot(sx - w.x, sz - w.z) || 1;
  const ux = (sx - w.x) / len;
  const uz = (sz - w.z) / len;
  const stand = w.radius + 150;
  return {
    x: w.x + ux * stand,
    y: 6,
    z: w.z + uz * stand,
    yaw: 0,
    pitch: -0.03,
    aimAt: { x: sx, z: sz },
  };
}

/** Frame the Gilded Wreck from off her quarter and ABOVE — a boarding look down
 *  onto her deck, her rig and the water she lies in.
 *
 *  Down, not level, on purpose: she rises at a different ring centre every
 *  match, so a horizon-level shot grades whatever island happens to be behind
 *  her that game. Measured in one world at eye level the same event cost 1214,
 *  1526 and 2283 draws from three stands; looking down onto her it was 1752,
 *  1763 and 1745. A budget has to measure the thing it names. */
export function planWreckScene(wreck) {
  const bearing = (wreck.rotation ?? 0) + Math.PI * 0.42;
  const stand = 70;
  return {
    x: wreck.position.x + Math.sin(bearing) * stand,
    y: 34,
    z: wreck.position.z + Math.cos(bearing) * stand,
    yaw: 0,
    pitch: -0.42,
    aimAt: { x: wreck.position.x, z: wreck.position.z },
  };
}

/**
 * WHERE THE DRAWS COME FROM.
 *
 * A draw-call total tells you a budget broke; it never tells you which content
 * wave broke it, and "3000 draws at deck view" is not something anyone can act
 * on. This walks the live scene the way three's renderer does — visible, in the
 * frustum, counting an InstancedMesh as the ONE call it actually is — and
 * attributes every call to the subsystem that owns it, keyed off the nearest
 * named ancestor. The keys are the node names the builders already set, so the
 * report reads as a list of modules, not of meshes.
 */
export const TALLY_DRAW_SOURCES = () => {
  const g = window.__piratesBR;
  const camera = g.renderer.camera;
  const scene = g.renderer.scene;
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();

  // Frustum, built by hand so this needs no THREE import of its own.
  const m = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  const e = m.elements;
  const planes = [];
  const push = (a, b, c, d) => {
    const len = Math.hypot(a, b, c) || 1;
    planes.push([a / len, b / len, c / len, d / len]);
  };
  push(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
  push(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  push(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
  push(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  push(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);
  push(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);

  const bucketFor = (node) => {
    // Nearest ancestor (including self) carrying a name a builder chose.
    for (let c = node; c; c = c.parent) {
      const n = c.name;
      if (!n) continue;
      if (n === 'island-micro-root') return 'island-micro';
      if (n.startsWith('island-') && n !== 'island-detail-root') return n;
      if (n.startsWith('decor-')) return 'island-decor';
      if (n.startsWith('waterfall-')) return 'waterfall';
      if (n.startsWith('cave')) return 'cave';
      if (n.startsWith('ship') || n.startsWith('hull')) return 'ship';
      if (n.startsWith('sea-rock')) return 'sea-rock';
      if (n === 'environment') break;
    }
    for (let c = node; c; c = c.parent) {
      if (c.parent === scene) return c.name || '(scene child)';
    }
    return '(unnamed)';
  };

  const tally = {};
  const inFrustum = (mesh) => {
    const geo = mesh.geometry;
    if (!geo) return true;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    if (!bs) return true;
    const c = bs.center.clone().applyMatrix4(mesh.matrixWorld);
    const el = mesh.matrixWorld.elements;
    const scale = Math.sqrt(Math.max(
      el[0] * el[0] + el[1] * el[1] + el[2] * el[2],
      el[4] * el[4] + el[5] * el[5] + el[6] * el[6],
      el[8] * el[8] + el[9] * el[9] + el[10] * el[10],
    ));
    const r = bs.radius * scale;
    for (const p of planes) {
      if (p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r) return false;
    }
    return true;
  };

  const walk = (node) => {
    if (!node.visible) return;
    if ((node.isMesh || node.isPoints || node.isLine || node.isSprite)) {
      const drawn = node.frustumCulled === false || inFrustum(node);
      if (drawn) {
        const groups = node.geometry?.groups ?? [];
        // A multi-material mesh is one call per group; everything else is one.
        const calls = Array.isArray(node.material) && groups.length > 0 ? groups.length : 1;
        const key = bucketFor(node);
        const t = (tally[key] ??= { calls: 0, meshes: 0 });
        t.calls += calls;
        t.meshes += 1;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(scene);

  return Object.entries(tally)
    .map(([source, v]) => ({ source, calls: v.calls, meshes: v.meshes }))
    .sort((a, b) => b.calls - a.calls);
};
