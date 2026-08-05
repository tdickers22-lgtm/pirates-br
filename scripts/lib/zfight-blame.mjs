// WHICH TWO SURFACES ARE FIGHTING — by taking one of them away.
//
// The tie census says how many pixels stand on a depth-buffer tie; it does not
// say whose. A raycast through a tie pixel is the obvious answer and it is a bad
// one here: three's raycaster ignores `visible`, so it happily names a hidden
// LOD proxy, and `Line.threshold` is a metre wide, so at the hull every pierce
// comes back as rigging. Both were tried; both named the wrong thing.
//
// So blame by ABLATION. A tie needs both of its surfaces. Hide the meshes of one
// material and re-run the flip: if the coplanar patch goes to zero, that material
// was one of the two, and the other is whatever the pixels now show. Two
// materials will zero the same patch — that pair IS the fight.
//
// EVERY RENDER OF A SWEEP HAPPENS IN ONE SYNCHRONOUS TASK. `deck-aft` is anchored
// to the local hull and the hull SAILS: the cost-model rig measured the same
// what-if at -0.552 and -0.098 layers twenty minutes apart for exactly this
// reason. A task cannot be interrupted by the game loop, so every render inside
// one call sees one pose and the counts are comparable with each other.

/**
 * WHERE ON THE SHIP, in the ship's own coordinates. Ablation names the two
 * materials; `mergeStaticMeshes` collapses a whole hull to one mesh per material,
 * so the name alone still covers eighty surfaces. A ray through a patch pixel,
 * reported in HULL-LOCAL x/y/z with its face normal, says which eighty-first.
 */
export const PIERCE_LOCAL = async (opts) => {
  // THE IMPORT COMES FIRST, THE PARK AFTER IT. Awaiting yields to the event loop
  // and the game frame that runs there puts the hull back where the server says
  // it is; parking before the await would aim every ray at a ship that has moved.
  const THREE = await import('/node_modules/three/build/three.module.js');
  const points = opts.points;
  const g = window.__piratesBR;
  const camera = g.renderer.camera;
  const scene = g.renderer.scene;
  const ships = g.state?.ships ?? [];
  const ship = ships.find((s) => s.ownerId === g.localPlayerId) ?? ships[0] ?? null;
  const root = ship ? (g.shipRenderer?.shipMeshes?.get(ship.id)?.root ?? null) : null;
  if (opts.park && root) {
    const islands = g.state?.islands ?? [];
    const dock = islands.find((i) => i.dock) ?? islands[0] ?? null;
    const px = dock.position.x + (dock.radius ?? 120) + 90;
    const pz = dock.position.z;
    root.position.set(px, 0, pz);
    root.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const p = opts.park;
    g.enableFreeCam(px + (p.dx ?? 0), (p.dy ?? 4.2), pz + (p.dz ?? 0), p.yaw ?? Math.PI, p.pitch ?? -0.05);
    if (p.tod !== undefined) g.setDayNightOverride(p.tod);
    g.settleLod();
  }
  camera.updateMatrixWorld();
  scene.updateMatrixWorld();
  const inv = root ? new THREE.Matrix4().copy(root.matrixWorld).invert() : null;
  const only = opts.materials ?? null;
  const ray = new THREE.Raycaster();
  ray.far = 200;
  const out = [];
  for (const p of points) {
    ray.setFromCamera(
      new THREE.Vector2((p.x / opts.width) * 2 - 1, -((p.y / opts.height) * 2 - 1)),
      camera,
    );
    let hits = [];
    try { hits = ray.intersectObject(scene, true); } catch { hits = []; }
    out.push({
      x: p.x,
      y: p.y,
      hits: hits
        .filter((hit) => hit.object.visible && (!only || only.includes(hit.object.material?.name ?? '')))
        .slice(0, 4)
        .map((hit) => {
          const local = inv ? hit.point.clone().applyMatrix4(inv) : hit.point.clone();
          return {
            d: Number(hit.distance.toFixed(4)),
            material: hit.object.material?.name || hit.object.material?.type || null,
            lx: Number(local.x.toFixed(3)),
            ly: Number(local.y.toFixed(3)),
            lz: Number(local.z.toFixed(3)),
            n: hit.face ? [
              Number(hit.face.normal.x.toFixed(2)),
              Number(hit.face.normal.y.toFixed(2)),
              Number(hit.face.normal.z.toFixed(2)),
            ] : null,
          };
        }),
    });
  }
  return out;
};

/** Every material actually reachable by a drawn node, with who owns it. */
export const LIST_MATERIALS = () => {
  const R = window.__piratesBR.renderer;
  const chainVisible = (o) => {
    for (let c = o; c; c = c.parent) if (!c.visible) return false;
    return true;
  };
  const ownerOf = (o) => {
    for (let c = o; c; c = c.parent) if (c.name) return c.name;
    return o.type;
  };
  const out = new Map();
  R.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m) continue;
      let e = out.get(m.uuid);
      if (!e) {
        e = {
          uuid: m.uuid, name: m.name || '', type: m.type,
          meshes: 0, drawn: 0, owners: new Set(),
          transparent: !!m.transparent, depthWrite: m.depthWrite !== false,
          polygonOffset: !!m.polygonOffset,
        };
        out.set(m.uuid, e);
      }
      e.meshes += 1;
      if (chainVisible(o)) { e.drawn += 1; e.owners.add(ownerOf(o)); }
    }
  });
  return [...out.values()]
    .filter((e) => e.drawn > 0)
    .map((e) => ({ ...e, owners: [...e.owners].slice(0, 4) }));
};

/**
 * ONE ABLATION SWEEP. Baseline first, then each uuid hidden in turn, all in this
 * one task. `probe` optionally restricts the count to a screen box, so a fight in
 * the corner of the frame is not drowned by the honest intersection lines
 * everywhere else.
 */
export const BLAME_SWEEP = (opts) => {
  const LESS_DEPTH = 2;
  const LESS_EQUAL_DEPTH = 3;
  const g = window.__piratesBR;
  const R = g.renderer;

  // PARK THE HULL AT THE TOP OF THE TASK THAT COUNTS.
  //
  // A ship-relative stand does not survive a sweep. The camera is placed once
  // from a world point and the hull SAILS out from under it: measured, this
  // sweep's own baseline went from 615 patch pixels to 0 in four chunks, and
  // every ablation after that was compared against a frame with no deck in it.
  // Pinning the render transform inside this task fixes the pose for every
  // render the task takes — the game loop cannot interleave — and the same
  // world point in the same seed fixes it across chunks too.
  if (opts.park) {
    const ships = g.state?.ships ?? [];
    const ship = ships.find((s) => s.ownerId === g.localPlayerId) ?? ships[0] ?? null;
    const mesh = ship ? (g.shipRenderer?.shipMeshes?.get(ship.id) ?? null) : null;
    const islands = g.state?.islands ?? [];
    const dock = islands.find((i) => i.dock) ?? islands[0] ?? null;
    if (!mesh || !dock) return { error: 'no local hull or island to park against' };
    const px = dock.position.x + (dock.radius ?? 120) + 90;
    const pz = dock.position.z;
    // ATTITUDE, NOT JUST POSITION. The hull's pitch, roll and heave are rewritten
    // from the Gerstner field every game frame, and a coplanar pair's tie moves
    // with them: chunk baselines read 51, 0 and 135 patch pixels on three
    // consecutive sweeps of a hull that was already pinned in x and z. A blame
    // sweep needs ONE pose, so the whole transform is pinned, rocking included.
    const y = 0;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) {
      return { error: `non-finite park pose ${px},${pz}` };
    }
    mesh.root.position.set(px, y, pz);
    mesh.root.rotation.set(0, 0, 0);
    mesh.root.updateMatrixWorld(true);
    const p = opts.park;
    g.enableFreeCam(px + (p.dx ?? 0), y + (p.dy ?? 4.2), pz + (p.dz ?? 0), p.yaw ?? Math.PI, p.pitch ?? -0.05);
    if (p.tod !== undefined) g.setDayNightOverride(p.tod);
    g.settleLod();
  }
  const renderer = R.renderer;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const bytes = w * h * 4;
  const a = new Uint8Array(bytes);
  const b = new Uint8Array(bytes);
  const c = new Uint8Array(bytes);

  const realNow = performance.now.bind(performance);
  const frozenAt = realNow();
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

  const ownerOf = (o) => {
    for (let n = o; n; n = n.parent) if (n.name) return n.name;
    return o.type;
  };
  const materials = new Set();
  const byUuid = new Map();
  const byOwner = new Map();
  R.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m) continue;
      materials.add(m);
      let list = byUuid.get(m.uuid);
      if (!list) { list = []; byUuid.set(m.uuid, list); }
      if (!list.includes(o)) list.push(o);
      const own = ownerOf(o);
      let olist = byOwner.get(own);
      if (!olist) { olist = []; byOwner.set(own, olist); }
      if (!olist.includes(o)) olist.push(o);
    }
  });
  const sky = R.skyMaterial ?? null;
  const flippable = [...materials].filter((m) => {
    if (m.depthTest === false) return false;
    if (m === sky) return false;
    const f = m.depthFunc ?? LESS_EQUAL_DEPTH;
    return f === LESS_EQUAL_DEPTH || f === LESS_DEPTH;
  });
  const flip = () => {
    for (const m of flippable) {
      m.depthFunc = m.depthFunc === LESS_EQUAL_DEPTH ? LESS_DEPTH : LESS_EQUAL_DEPTH;
    }
  };

  // readPixels is bottom-up; the box arrives in screenshot coordinates.
  const box = opts.box
    ? { x0: opts.box.x0, x1: opts.box.x1, y0: h - 1 - opts.box.y1, y1: h - 1 - opts.box.y0 }
    : { x0: 0, x1: w - 1, y0: 0, y1: h - 1 };

  const score = () => {
    const mask = new Uint8Array(w * h);
    let ties = 0;
    let loud = 0;
    for (let y = box.y0; y <= box.y1; y += 1) {
      for (let x = box.x0; x <= box.x1; x += 1) {
        const p = y * w + x;
        const i = p * 4;
        const d = Math.max(
          Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]),
        );
        if (d === 0) continue;
        mask[p] = 1;
        ties += 1;
        if (d > 24) loud += 1;
      }
    }
    let patch = 0;
    let px = 0;
    let py = 0;
    const samples = [];
    for (let y = Math.max(1, box.y0); y <= Math.min(h - 2, box.y1); y += 1) {
      for (let x = Math.max(1, box.x0); x <= Math.min(w - 2, box.x1); x += 1) {
        const p = y * w + x;
        if (!mask[p]) continue;
        if (mask[p - 1] && mask[p + 1] && mask[p - w] && mask[p + w]
          && mask[p - w - 1] && mask[p - w + 1] && mask[p + w - 1] && mask[p + w + 1]) {
          patch += 1;
          px += x;
          py += y;
          // Screenshot coordinates, spread across the patch rather than bunched
          // at its start, so a pierce samples the whole fight and not one corner.
          if (patch % 37 === 1 && samples.length < 24) samples.push({ x, y: h - 1 - y });
        }
      }
    }
    return {
      ties,
      loud,
      patch,
      samples,
      cx: patch ? Math.round(px / patch) : null,
      cy: patch ? h - 1 - Math.round(py / patch) : null,
    };
  };

  const measure = () => { shoot(a); flip(); shoot(b); flip(); return score(); };

  shoot(a);
  shoot(c);
  let selfNoise = 0;
  for (let i = 0; i < bytes; i += 4) {
    if (a[i] !== c[i] || a[i + 1] !== c[i + 1] || a[i + 2] !== c[i + 2]) selfNoise += 1;
  }

  const base = measure();
  const results = [];
  // A COARSE PASS FIRST IS CHEAPER THAN A FINE ONE. 517 materials are drawn at
  // deck-aft and one ablation is two software renders; ~30 named owners localise
  // the fight to a subtree in a tenth of the time, and the material sweep then
  // only has to cover that subtree.
  for (const owner of opts.owners ?? []) {
    const nodes = byOwner.get(owner) ?? [];
    const saved = nodes.map((n) => n.visible);
    for (const n of nodes) n.visible = false;
    let r;
    try { r = measure(); } finally { nodes.forEach((n, i) => { nodes[i].visible = saved[i]; }); }
    results.push({ owner, nodes: nodes.length, ...r });
  }
  for (const uuid of opts.uuids ?? []) {
    const nodes = byUuid.get(uuid) ?? [];
    const saved = nodes.map((n) => n.visible);
    for (const n of nodes) n.visible = false;
    let r;
    try { r = measure(); } finally { nodes.forEach((n, i) => { nodes[i].visible = saved[i]; }); }
    results.push({ uuid, nodes: nodes.length, ...r });
  }
  return {
    width: w,
    height: h,
    selfNoise,
    base,
    results,
    owners: opts.listOwners ? [...byOwner.entries()].map(([k, v]) => ({ owner: k, nodes: v.length })) : undefined,
  };
};
