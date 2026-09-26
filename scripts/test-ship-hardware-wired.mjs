// SHIP HARDWARE WIRED — the cannon / wheel / capstan / ship_lantern GLBs are on
// the hulls, on the right pivots, turning the right way (b3.4e, assets-01).
//
// The four files (+ _far siblings) were built, gated by test-hero-assets and
// loaded by nothing: every hull drew primitive cylinders and tori for the props
// a player stares at all match. This gate builds every hull class through
// ShipRenderer with a STUB library that serves the real GLB geometry (read
// straight from public/assets/models, no textures, no browser) and pins:
//   [a] every hull class mounts cannon_body + barrel per gun, wheel_body, drum,
//       capstan_body, and one ship_lantern_body per lantern mount; the procedural
//       carriage/barrel is gone from the cannon pivots (no double gun)
//   [b] the barrel hangs off the pitch pivot on its trunnions: +pitch raises the
//       muzzle (server pitch = operator.rotation.y, same sign as before)
//   [c] wheel spin sign from signConventions.helmWheelRotZ: rudder +1 turns
//       mesh.wheel.rotation.z the same sign AND carries the GLB's top handle
//       toward local -X (the helmsman's right, the way the bow goes)
//   [d] capstan: raising the anchor turns the GLB drum +Y while the base stays put
//   [e] far sibling: near inside farSwapDistance, far beyond it, far only on low
//   [f] low tier: per-ship triangles and draws do not rise over the procedural hull
//   [g] IK grips come out of the GLB (wheel handles, capstan bar ends, breech)
//   [h] clear() does not dispose the library's shared geometry
//   [i] late mount: a hull built before the library loaded swaps on update
//
// RED ON HEAD: ShipRenderer has no setHardwareSource and mounts nothing.
// Mutation: PIRATES_BR_MUTATE=hw:off (no source) and hw:wheelsign (negated
// convention check) each fail.
//
//   node --import tsx scripts/test-ship-hardware-wired.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCanvasStub } from './lib/canvas-stub.mjs';
installCanvasStub();
const THREE = await import('three');
const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
const { SHIP, SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { helmWheelRotZ } = await import('../src/client/rendering/signConventions.ts');
const { farSwapDistance } = await import('../src/client/world/island/InstanceLod.ts');
const { openFirstDrawBudgetForSettle } = await import('../src/client/rendering/FirstDrawBudget.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public/assets/models');
const MUTATE = process.env.PIRATES_BR_MUTATE ?? '';

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

// ── stub library: real GLB geometry, no textures ────────────────────────────
const COMP = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function loadGlbScene(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const binStart = 20 + jl + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jl));
  const acc = (i) => {
    const a = json.accessors[i]; const bv = json.bufferViews[a.bufferView];
    const T = COMP[a.componentType]; const w = WIDTH[a.type];
    const stride = bv.byteStride ?? 0;
    const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (stride && stride !== w * T.BYTES_PER_ELEMENT) {
      const out = new T(a.count * w);
      for (let k = 0; k < a.count; k++) for (let c = 0; c < w; c++) {
        out[k * w + c] = new T(bin.buffer.slice(bin.byteOffset + off + k * stride + c * T.BYTES_PER_ELEMENT, bin.byteOffset + off + k * stride + (c + 1) * T.BYTES_PER_ELEMENT))[0];
      }
      return out;
    }
    return new T(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + a.count * w * T.BYTES_PER_ELEMENT));
  };
  const mats = (json.materials ?? []).map((m) => { const mm = new THREE.MeshStandardMaterial(); mm.name = m.name; return mm; });
  const build = (ni) => {
    const n = json.nodes[ni];
    const obj = new THREE.Group();
    obj.name = n.name ?? '';
    if (n.mesh !== undefined) {
      for (const p of json.meshes[n.mesh].primitives) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(acc(p.attributes.POSITION), 3));
        if (p.indices !== undefined) g.setIndex(new THREE.BufferAttribute(acc(p.indices), 1));
        const mesh = new THREE.Mesh(g, mats[p.material ?? 0] ?? new THREE.MeshStandardMaterial());
        mesh.name = obj.name;
        obj.add(mesh);
      }
    }
    if (n.translation) obj.position.fromArray(n.translation);
    if (n.rotation) obj.quaternion.fromArray(n.rotation);
    if (n.scale) obj.scale.fromArray(n.scale);
    for (const c of n.children ?? []) obj.add(build(c));
    return obj;
  };
  const scene = new THREE.Group();
  for (const ni of json.scenes[json.scene ?? 0].nodes) scene.add(build(ni));
  return scene;
}
const HW = ['cannon', 'wheel', 'capstan', 'ship_lantern'];
const templates = new Map();
for (const n of HW) {
  templates.set(n, loadGlbScene(`${n}.glb`));
  templates.set(`${n}_far`, loadGlbScene(`${n}_far.glb`));
}
const disposed = [];
for (const t of templates.values()) t.traverse((o) => o.geometry?.addEventListener('dispose', () => disposed.push(o.name)));
function stubSource(loaded = () => true) {
  return {
    has: (n) => loaded() && templates.has(n),
    clone: (n) => (loaded() ? templates.get(n)?.clone(true) ?? null : null),
    cloneFar: (n) => (loaded() ? templates.get(`${n}_far`)?.clone(true) ?? null : null),
  };
}

function fixtureShip(type, id = `hw-${type}`) {
  return {
    id, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
    velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
    anchorRaiseProgress: 0, rudderAngle: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
    fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
    sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
    repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
  };
}
function renderer(quality, source) {
  const sr = new ShipRenderer();
  const hasApi = typeof sr.setHardwareSource === 'function';
  if (hasApi && source && MUTATE !== 'hw:off') sr.setHardwareSource(source);
  sr.init(new THREE.Scene(), quality);
  return { sr, hasApi };
}
const named = (root, name) => { const out = []; root.traverse((o) => { if (o.name === name && !o.isMesh) out.push(o); }); return out; };
function visibleCost(root) {
  let tris = 0, draws = 0;
  const walk = (o) => {
    if (!o.visible) return;
    if (o.isMesh && o.geometry?.attributes?.position) {
      const g = o.geometry;
      const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
      const inst = o.isInstancedMesh ? o.count : 1;
      tris += n * inst; draws += 1;
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return { tris: Math.round(tris), draws };
}
openFirstDrawBudgetForSettle();
const near = new THREE.Vector3(6, 4, 6);
const settle = (sr, ship, t0 = 0, cam = near) => { for (let i = 0; i < 40; i++) sr.update([ship], [], t0 + i * 0.001, 0.5, 0, cam); };

// ── [a] every hull class mounts the hardware ────────────────────────────────
console.log('[a] mounts per hull class');
const { sr: srHigh, hasApi } = renderer('high', stubSource());
expect('ShipRenderer.setHardwareSource exists', hasApi, 'no way to hand ShipRenderer the hardware GLBs');
for (const type of Object.keys(SHIP_STATS)) {
  const ship = fixtureShip(type);
  srHigh.buildShip(ship);
  const mesh = srHigh.shipMeshes.get(ship.id);
  const d = mesh.detailRoot;
  const guns = SHIP_STATS[type].cannonCount;
  const count = (n) => named(d, n).length;
  const lanternMounts = 1 + (SHIP_STATS[type].mastCount === 1 ? 1 : 0) + (type === 'galleon' ? 1 : 0);
  console.log(`  ${type.padEnd(11)} guns ${guns}: cannon_body ${count('cannon_body')}, barrel ${count('barrel')}, wheel_body ${count('wheel_body')}, capstan_body ${count('capstan_body')}, drum ${count('drum')}, ship_lantern_body ${count('ship_lantern_body')}`);
  // near + far sibling of each: 2 per mount
  expect(`[a] ${type}: cannon_body + barrel on all ${guns} guns (near + far)`, count('cannon_body') === guns * 2 && count('barrel') === guns * 2);
  expect(`[a] ${type}: wheel_body, capstan_body, drum mounted`, count('wheel_body') === 2 && count('capstan_body') === 2 && count('drum') === 2);
  expect(`[a] ${type}: ship_lantern_body on every lantern mount`, count('ship_lantern_body') >= lanternMounts * 2 && count('ship_lantern_body') % 2 === 0,
    `${count('ship_lantern_body')} for ${lanternMounts} mounts`);
  const strays = (mesh.cannonMeshes ?? []).flatMap((c) => [
    ...c.root.children.filter((x) => x !== c.yawPivot && !x.name.startsWith('hw-') && x.name !== 'upgrade-charged-cannon'),
    ...c.pitchPivot.children.filter((x) => !x.name.startsWith('hw-') && x.name !== 'upgrade-charged-cannon'),
  ]);
  expect(`[a] ${type}: no procedural carriage/barrel left on the cannon pivots`, strays.length === 0, strays.map((x) => x.name || x.type).join(', '));
  const glass = named(d, 'ship_lantern_body').length ? mesh.lanternGlassMats[0] : null;
  let glassUsers = 0;
  d.traverse((o) => { if (o.isMesh && o.material === glass) glassUsers += 1; });
  expect(`[a] ${type}: GLB lantern glass is the ship's night-ramped glass`, !!glass && glassUsers >= lanternMounts);
}

// ── [b] barrel elevation ────────────────────────────────────────────────────
{
  const ship = fixtureShip('brigantine', 'hw-pitch');
  srHigh.buildShip(ship);
  const cannon = srHigh.shipMeshes.get(ship.id)?.cannonMeshes?.[0];
  const barrel = cannon ? named(cannon.pitchPivot, 'barrel')[0] : null;
  expect('[b] the GLB barrel is under the pitch pivot', !!barrel);
  if (barrel) {
    const tip = () => { barrel.updateWorldMatrix(true, true); const b = new THREE.Box3().setFromObject(barrel); return b; };
    const rest = tip();
    cannon.pitchPivot.rotation.z = 0.3;
    const up = tip();
    cannon.pitchPivot.rotation.z = 0;
    const pivotW = cannon.pitchPivot.getWorldPosition(new THREE.Vector3());
    console.log(`  barrel top y ${rest.max.y.toFixed(3)} -> ${up.max.y.toFixed(3)} at +0.3 rad; pivot y ${pivotW.y.toFixed(3)}, barrel box y ${rest.min.y.toFixed(3)}..${rest.max.y.toFixed(3)}`);
    expect('[b] +pitch (server operator.rotation.y) raises the muzzle', up.max.y > rest.max.y + 0.15);
    expect('[b] the pivot is on the trunnions (inside the barrel box, not its end)', pivotW.y > rest.min.y && pivotW.y < rest.max.y);
  }
}

// ── [c] wheel spin sign ─────────────────────────────────────────────────────
{
  const ship = fixtureShip('brigantine', 'hw-wheel');
  ship.anchored = true;
  const { sr } = renderer('high', stubSource());
  settle(sr, ship, 5);
  const mesh = sr.shipMeshes.get(ship.id);
  const wb = named(mesh.wheel, 'wheel_body')[0];
  expect('[c] wheel_body spins with mesh.wheel', !!wb);
  if (wb) {
    const grips = mesh.wheel.userData.ikGrips?.points ?? [];
    const topLocal = grips.reduce((a, p) => (p.y > (a?.y ?? -Infinity) ? p : a), null) ?? new THREE.Vector3(0, 0.5, 0);
    const shipLocal = () => mesh.root.worldToLocal(mesh.wheel.localToWorld(topLocal.clone()));
    const rest = mesh.wheel.rotation.z; const topRest = shipLocal();
    // The first few degrees show which way the top handle STARTS to travel.
    ship.rudderAngle = SHIP.RUDDER_MAX_ANGLE * 0.1;
    settle(sr, ship, 6);
    const topOver = shipLocal();
    ship.rudderAngle = SHIP.RUDDER_MAX_ANGLE;
    settle(sr, ship, 7);
    const over = mesh.wheel.rotation.z;
    let want = Math.sign(helmWheelRotZ(1));
    if (MUTATE === 'hw:wheelsign') want = -want;
    console.log(`  rudder 0 -> +1: wheel.rotation.z ${rest.toFixed(3)} -> ${over.toFixed(3)} (convention sign ${Math.sign(helmWheelRotZ(1))}); top handle x ${topRest.x.toFixed(3)} -> ${topOver.x.toFixed(3)}`);
    expect('[c] rudder +1 moves wheel.rotation.z with the helmWheelRotZ sign', Math.sign(over - rest) === want && Math.abs(over - rest) > 1);
    expect('[c] the top handle of the GLB wheel goes to local -X (the bow\'s way)', topOver.x < topRest.x - 0.02 && want > 0);
  }
}

// ── [d] capstan ─────────────────────────────────────────────────────────────
{
  const ship = fixtureShip('sloop', 'hw-capstan');
  const { sr } = renderer('high', stubSource());
  settle(sr, ship, 1);
  const mesh = sr.shipMeshes.get(ship.id);
  const drum = named(mesh.detailRoot, 'drum')[0];
  const base = named(mesh.detailRoot, 'capstan_body')[0];
  const yaw = (o) => new THREE.Euler().setFromQuaternion(o.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
  if (drum && base) {
    ship.anchored = true; ship.anchorRaiseProgress = 0.5;
    const d0 = mesh.anchorCapstan.rotation.y; const b0 = yaw(base);
    for (let i = 0; i < 10; i++) sr.update([ship], [], 2 + i * 0.016, 0.016, 0, near);
    const d1 = mesh.anchorCapstan.rotation.y; const b1 = yaw(base);
    console.log(`  raising: capstan rotation.y ${d0.toFixed(3)} -> ${d1.toFixed(3)}; base yaw ${b0.toFixed(3)} -> ${b1.toFixed(3)}`);
    expect('[d] the drum is on the rotating capstan holder', drum.parent === mesh.anchorCapstan);
    expect('[d] raising the anchor turns the drum +Y', d1 - d0 > 0.3);
    expect('[d] the base stays on the deck (does not turn)', Math.abs(b1 - b0) < 1e-6);
  } else expect('[d] capstan drum + base mounted', false);
}

// ── [e] far sibling at farSwapDistance ──────────────────────────────────────
for (const q of ['high', 'balanced', 'low']) {
  const ship = fixtureShip('galleon', `hw-far-${q}`);
  const { sr } = renderer(q, stubSource());
  const swap = farSwapDistance(q);
  const at = (m) => { settle(sr, ship, 3, new THREE.Vector3(m, 5, 0)); return sr.shipMeshes.get(ship.id).hardware; };
  const nearHw = at(10);
  const nearFar = nearHw?.far;
  const farHw = at(swap * 1.1);
  const farFar = farHw?.far;
  const allFar = farHw?.parts?.every((p) => !p.far || (p.far.visible && !p.near.visible));
  console.log(`  ${q}: swap ${swap} m -> at 10 m far=${nearFar}, at ${(swap * 1.1).toFixed(0)} m far=${farFar}`);
  if (q === 'low') expect('[e] low: far sibling even at 10 m (never LOD0)', nearFar === true && farFar === true && allFar);
  else expect(`[e] ${q}: near at 10 m, far beyond ${swap} m`, nearFar === false && farFar === true && allFar);
}

// ── [f] low tier cost does not rise ─────────────────────────────────────────
for (const type of Object.keys(SHIP_STATS)) {
  const cost = (src) => {
    const { sr } = renderer('low', src);
    const ship = fixtureShip(type, `hw-cost-${type}-${src ? 'glb' : 'proc'}`);
    settle(sr, ship, 4);
    return visibleCost(sr.shipMeshes.get(ship.id).detailRoot);
  };
  const proc = cost(null); const glb = cost(stubSource());
  console.log(`  ${type.padEnd(11)} low: procedural ${proc.tris} tris / ${proc.draws} draws -> GLB ${glb.tris} tris / ${glb.draws} draws`);
  expect(`[f] ${type} low: triangles do not rise`, glb.tris <= proc.tris, `${glb.tris} > ${proc.tris}`);
  expect(`[f] ${type} low: draws do not rise`, glb.draws <= proc.draws, `${glb.draws} > ${proc.draws}`);
}

// ── [g] IK grips from the GLB ───────────────────────────────────────────────
{
  const ship = fixtureShip('galleon', 'hw-grips');
  srHigh.buildShip(ship);
  const mesh = srHigh.shipMeshes.get(ship.id);
  const helm = mesh.wheel.userData.ikGrips; const cap = mesh.anchorCapstan.userData.ikGrips;
  const gun = mesh.cannonMeshes[0].pitchPivot.userData.ikGrips;
  const radius = (p, plane) => (plane === 'xy' ? Math.hypot(p.x, p.y) : Math.hypot(p.x, p.z));
  const hr = helm?.points?.map((p) => radius(p, 'xy')) ?? [];
  const cr = cap?.points?.map((p) => radius(p, 'xz')) ?? [];
  console.log(`  helm ${hr.length} grips r ${Math.min(...hr).toFixed(3)}..${Math.max(...hr).toFixed(3)} (rim ${mesh.wheelRimR.toFixed(3)}); capstan ${cr.length} grips r ${Math.min(...cr).toFixed(3)}..${Math.max(...cr).toFixed(3)}; breech grip x ${gun?.points?.[0]?.x?.toFixed(3)}`);
  expect('[g] helm grips are the GLB handle tips (>= 6, past the rim)', hr.length >= 6 && Math.min(...hr) > mesh.wheelRimR);
  expect('[g] capstan grips are the GLB bar ends (>= 4, same radius)', cr.length >= 4 && Math.max(...cr) - Math.min(...cr) < 0.08);
  expect('[g] cannon grips sit behind the trunnions at the breech', !!gun && gun.points.every((p) => p.x < -0.3));
}

// ── [h] shared geometry survives clear() ────────────────────────────────────
srHigh.clear();
expect('[h] clear() leaves the library GLB geometry alive', disposed.length === 0, `disposed: ${[...new Set(disposed)].join(', ')}`);

// ── [i] late mount ──────────────────────────────────────────────────────────
{
  let loaded = false;
  const { sr } = renderer('high', stubSource(() => loaded));
  const ship = fixtureShip('brigantine', 'hw-late');
  settle(sr, ship, 1);
  const before = named(sr.shipMeshes.get(ship.id).detailRoot, 'cannon_body').length;
  loaded = true;
  settle(sr, ship, 2);
  const after = named(sr.shipMeshes.get(ship.id).detailRoot, 'cannon_body').length;
  console.log(`  cannon_body before load ${before}, after ${after}`);
  expect('[i] a hull built in the queue window swaps to the GLBs once they load', before === 0 && after === SHIP_STATS.brigantine.cannonCount * 2);
}

console.log(`\n${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
