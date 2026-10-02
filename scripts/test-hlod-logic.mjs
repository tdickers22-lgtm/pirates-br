// Island HLOD logic gate (b4.4a): the pure rules under island/IslandImpostor,
// with no browser. What it proves:
//   1. sectorOf covers 8 angular x 2 radial sectors, every index reachable,
//      ring split at half the island radius.
//   2. hlodTier: near / mid / far at the desktop (180 / 450) and phone
//      (120 / 320) bands, with the 8% hysteresis only on the way OUT.
//   3. HlodSector.update: near group shown only in the near tier, mid group in
//      near + mid, nothing in far, mid casts only inside the caster band.
//   4. buildIslandHlod on a synthetic island: a lantern piece (PointLight) is
//      merged after its light is lifted onto the detail root, a userData piece
//      is refused and counted, the terrain goes behind the far switch which is
//      the detail root's FIRST child, and the far proxy is never a raycast hit.
//   5. HlodFarSwitch: full terrain near / mid, baked proxy only in the far tier.
//
//   node --import tsx scripts/test-hlod-logic.mjs [--mutate=hlod-off]
//
// --mutate=hlod-off runs the same checks under `?hlod=off` (the pre-HLOD
// build): no sectors, no far switch, so checks 4 and 5 FAIL. A gate that cannot
// fail is a bug.
const MUTATE = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice('--mutate='.length);
if (MUTATE === 'hlod-off') globalThis.location = { search: '?hlod=off' };

const THREE = await import('three');
const {
  sectorOf, hlodTier, HLOD_BANDS_DESKTOP, HLOD_BANDS_PHONE, HLOD_ANGULAR, HLOD_RADIAL,
  HlodSector, buildIslandHlod,
} = await import('../src/client/world/island/IslandImpostor.ts');

let fails = 0;
let passes = 0;
const check = (cond, label) => {
  if (cond) passes += 1;
  else { fails += 1; console.log(`  FAIL ${label}`); }
};

// 1. sectorOf
{
  const R = 200;
  const seen = new Set();
  for (let i = 0; i < 720; i++) {
    const a = (i / 720) * Math.PI * 2;
    for (const r of [20, 80, 120, 190]) {
      const s = sectorOf(Math.cos(a) * r, Math.sin(a) * r, R);
      check(s >= 0 && s < HLOD_ANGULAR * HLOD_RADIAL, `sectorOf in range (${s})`);
      check((s >= HLOD_ANGULAR) === (r >= R * 0.5), `ring split at R/2 (r=${r}, s=${s})`);
      seen.add(s);
    }
  }
  check(seen.size === HLOD_ANGULAR * HLOD_RADIAL, `all ${HLOD_ANGULAR * HLOD_RADIAL} sectors reachable (saw ${seen.size})`);
  check(sectorOf(-1, -1e-9, R) === sectorOf(-1, 1e-9, R) || true, 'atan2 seam does not throw');
}

// 2. hlodTier
{
  const D = HLOD_BANDS_DESKTOP;
  const P = HLOD_BANDS_PHONE;
  check(D.near === 180 && D.mid === 450, 'desktop bands 180 / 450');
  check(P.near === 120 && P.mid === 320 && P.caster === 30, 'phone bands 120 / 320, casters 30');
  check(hlodTier(100, 2, D) === 0, 'desktop 100 m -> near');
  check(hlodTier(185, 1, D) === 1, 'desktop 185 m entering -> mid');
  check(hlodTier(185, 0, D) === 0, 'desktop 185 m leaving near -> stays near (hysteresis)');
  check(hlodTier(200, 0, D) === 1, 'desktop 200 m -> past hysteresis, mid');
  check(hlodTier(470, 1, D) === 1, 'desktop 470 m leaving mid -> stays mid');
  check(hlodTier(470, 2, D) === 2, 'desktop 470 m entering -> far');
  check(hlodTier(500, 1, D) === 2, 'desktop 500 m -> far');
  check(hlodTier(150, 1, P) === 1, 'phone 150 m -> mid');
  check(hlodTier(330, 2, P) === 2, 'phone 330 m -> far');
}

const piece = (size, colour = 0x886644) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color: colour }));
  m.castShadow = true;
  return m;
};
const camAt = (x, y, z) => {
  const cam = new THREE.PerspectiveCamera(74, 16 / 9, 0.1, 5000);
  cam.position.set(x, y, z);
  cam.updateMatrixWorld(true);
  return cam;
};

// 3. HlodSector.update
{
  const sector = new HlodSector(3);
  const small = piece(1); small.position.set(50, 0, 0);
  const big = piece(5); big.position.set(52, 0, 0);
  sector.near.add(small);
  sector.mid.add(big);
  sector.seal();
  sector.updateMatrixWorld(true);
  const run = (dist) => { sector.update(camAt(50 + dist, 2, 0)); return { n: sector.near.visible, m: sector.mid.visible, c: big.castShadow }; };
  if (MUTATE === 'hlod-off') {
    // Disabled HLOD never changes tiers: everything stays as built.
    const r = run(900);
    check(!r.n && !r.m, '[expected FAIL under hlod-off] far sector hides both groups');
  } else {
    let r = run(60);
    check(r.n && r.m && r.c, 'sector at 60 m: near + mid shown, mid casts');
    r = run(300);
    check(!r.n && r.m && !r.c, 'sector at 300 m: mid only, no shadow');
    r = run(900);
    check(!r.n && !r.m, 'sector at 900 m: nothing');
    r = run(60);
    check(r.n && r.m && r.c, 'sector back at 60 m: restored, casting again');
  }
}

// 4 + 5. buildIslandHlod on a synthetic island
{
  const root = new THREE.Group();
  root.name = 'island-detail-root';
  const terrain = piece(150); terrain.name = 'island-terrain'; terrain.raycast = THREE.Mesh.prototype.raycast;
  root.add(terrain);
  const micro = new THREE.Group(); micro.name = 'island-micro-root';
  root.add(micro);
  const lantern = new THREE.Group(); lantern.name = 'decor-lantern-post';
  lantern.add(piece(4));
  const light = new THREE.PointLight(0xffaa55, 1, 10); light.position.set(0, 2, 0);
  lantern.add(light);
  lantern.position.set(40, 0, 10);
  root.add(lantern);
  const tagged = piece(4); tagged.name = 'decor-tagged'; tagged.userData.someSystem = 1; tagged.position.set(-40, 0, 0);
  root.add(tagged);
  const glbProp = piece(2); glbProp.name = 'prop-lantern_post'; glbProp.userData.assetFamily = 'props';
  // GLTFLoader copies every node's glTF name into userData.name (three r160): the a4 run
  // still refused 105 GLB props for exactly that key, so the fixture carries it too.
  glbProp.userData.name = 'lantern_post'; glbProp.position.set(20, 0, 30);
  root.add(glbProp);
  for (let i = 0; i < 12; i++) {
    const p = piece(1, 0x445566); const a = (i / 12) * Math.PI * 2;
    p.position.set(Math.cos(a) * 60, 0, Math.sin(a) * 60);
    micro.add(p);
  }
  const landmark = piece(12); landmark.name = 'decor-lookout-big'; landmark.position.set(0, 6, -70);
  root.add(landmark);

  const farMesh = () => new THREE.Mesh(new THREE.PlaneGeometry(150, 150, 40, 40), new THREE.MeshStandardMaterial());
  const stats = buildIslandHlod(root, micro, 100, new Set(), farMesh);
  root.updateMatrixWorld(true);

  check(stats.sectors > 0, `sectors built (${stats.sectors})`);
  check(stats.lights === 1 && light.parent === root, 'lantern light lifted onto the detail root');
  const lightWorld = light.getWorldPosition(new THREE.Vector3());
  check(Math.abs(lightWorld.x - 40) < 1e-6 && Math.abs(lightWorld.y - 2) < 1e-6 && Math.abs(lightWorld.z - 10) < 1e-6, 'lifted light keeps its world position');
  check(lantern.parent !== root && lantern.parent?.parent?.name?.startsWith('island-hlod-sector'), 'lantern piece joined a sector');
  check(stats.refused['decor-tagged:userData.someSystem'] === 1 && tagged.parent === root, 'userData piece refused, counted, left in place');
  check(stats.landmarks === 1, 'the 12 m piece is a landmark');
  check(glbProp.parent !== root && !stats.refused['prop-lantern_post:userData.assetFamily'] && !stats.refused['prop-lantern_post:userData.name'], 'an AssetLibrary prop (userData.assetFamily + GLTFLoader userData.name) joins a sector');
  const sw = root.children[0];
  check(sw?.name === 'island-hlod-far-switch', `far switch is the detail root's FIRST child (got ${sw?.name})`);
  check(terrain.parent?.name === 'island-hlod-terrain-full', 'terrain sits behind the switch');
  check(root.getObjectByName('island-terrain') === terrain, 'terrain still found by name');
  check(stats.farTris > 0, `far proxy baked (${stats.farTris} tris)`);
  if (sw?.name === 'island-hlod-far-switch') {
    const hits = [];
    new THREE.Raycaster(new THREE.Vector3(0, 500, 0), new THREE.Vector3(0, -1, 0)).intersectObject(sw.far, false, hits);
    check(hits.length === 0, 'far proxy is never a raycast hit');
    sw.updateMatrixWorld(true);
    sw.update(camAt(0, 30, 200));
    check(sw.full.visible && !sw.far.visible, 'switch near the island: full terrain');
    sw.update(camAt(0, 30, 1200));
    check(!sw.full.visible && sw.far.visible, 'switch 1 km out: baked proxy only');
    sw.update(camAt(0, 30, 150));
    check(sw.full.visible && !sw.far.visible, 'switch back in: full terrain again');
  } else {
    check(false, 'far switch behaviour (no switch built)');
  }
}

console.log(`${fails > 0 ? "FAIL" : "PASS"} test-hlod-logic: ${passes} passed, ${fails} failed${MUTATE ? ` [MUTATED: ${MUTATE}]` : ''}`);
process.exit(fails > 0 ? 1 : 0);
