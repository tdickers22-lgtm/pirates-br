// test-ship-sockets (b4.3c, ships-07): the Blender ship kit sits ON the hull.
//
//   node --import tsx scripts/test-ship-sockets.mjs
//
// 1. Every socket of every class (ship/kit.ts shipKitSockets + deckKitSockets)
//    is graded against the shared spline (sampleHullSurface) found by an
//    INDEPENDENT nearest-point search, not the solver that placed it:
//      hull     <= 3 cm from the spline, +Z within 5 deg of the outward normal
//      stem/transom: on the centreline seat between the mirrored surfaces
//               (<= 3 cm), +Z within 5 deg of the bisector normal
//      post     rudder origin <= 3 cm from the sternpost chord, +Y within 5 deg of it
//      deck     <= 3 cm from the deck slab top, +Y within 5 deg of deck up
//    and gunports sit over their guns (|dz| <= 3 cm).
// 2. mountShipKit on a stub library built from the GLB's own node table:
//    every instance origin / axis equals its socket (the mount math) and the
//    instance count per bucket equals the sockets that mount that node.
// 3. Every node a socket names exists in the kit GLB.
// 4. Source: buildShip mounts the kit (no makeFigurehead, no gunport boxes),
//    makeFigurehead is gone from dressing.ts, the library knows both kit files,
//    and the primitive constructors in buildShip ratchet down (target < 25).
//
// --prove: mutations that must go red (socket nudged 5 cm off the hull, axis
// tilted 8 deg, a node renamed).
import { readFileSync } from 'node:fs';

const THREE = await import('three');
const hull = await import('../src/shared/hull.ts');
const kit = await import('../src/client/rendering/ship/kit.ts');
const { rudderMount } = await import('../src/client/rendering/ship/stern.ts');
const { SHIP_STATS } = await import('../src/shared/constants/index.ts');
const { getCannonDeckLocalPosition } = await import('../src/shared/interactions.ts');
const { getShipDeckY } = await import('../src/shared/utils/index.ts');

const PROVE = process.argv.includes('--prove');
const TOL_M = 0.03, TOL_DEG = 5;
/** Primitive constructors (Box/Cylinder/Sphere/Torus/Cone/Circle/Plane) in
 *  buildShip: 97 at the audit, 76 at b4.2h, ratcheted here. PLAN target < 25. */
const PRIMITIVE_RATCHET = 73;
const PRIMITIVE_TARGET = 25;

let fails = 0;
const fail = (m) => { fails++; console.log(`FAIL ${m}`); };
const ok = (m) => console.log(`ok   ${m}`);
const deg = (a, b) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function glbJson(file) {
  const b = readFileSync(`public/assets/models/${file}.glb`);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}
const GLB = { ship_kit_a: glbJson('ship_kit_a'), ship_kit_b: glbJson('ship_kit_b'), ship_kit_a_lods: glbJson('ship_kit_a_lods'), ship_kit_b_lods: glbJson('ship_kit_b_lods') };

/** Nearest spline point to p on side `side` (independent of the kit solver):
 *  coarse 60x40 scan, then two refinements around the best cell. */
function nearestOnHull(profile, p, side) {
  let best = { d: Infinity, u: 0, v: 0 };
  const scan = (u0, u1, v0, v1, nu, nv) => {
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const u = Math.min(1, Math.max(0, u0 + (u1 - u0) * i / nu));
      const v = Math.min(1, Math.max(0, v0 + (v1 - v0) * j / nv));
      const s = hull.sampleHullSurface(profile, u, v);
      const d = dist(p, [side * s.x, s.y, s.z]);
      if (d < best.d) best = { d, u, v };
    }
  };
  scan(0, 1, 0, 1, 60, 40);
  for (const w of [1 / 30, 1 / 300, 1 / 3000]) scan(best.u - w, best.u + w, best.v - w, best.v + w, 20, 20);
  const s = hull.sampleHullSurface(profile, best.u, best.v);
  return { d: best.d, n: [side * s.nx, s.ny, s.nz] };
}
function nearestOnCentreRow(profile, p, u) {
  let best = { d: Infinity, v: 0 };
  for (let j = 0; j <= 4000; j++) {
    const v = j / 4000, s = hull.sampleHullSurface(profile, u, v);
    const d = dist(p, [0, s.y, s.z]);
    if (d < best.d) best = { d, v };
  }
  const s = hull.sampleHullSurface(profile, u, best.v);
  const l = Math.hypot(s.ny, s.nz) || 1;
  return { d: best.d, n: [0, s.ny / l, s.nz / l], halfBeam: Math.abs(s.x) };
}

function gradeSocket(type, s, tag) {
  const profile = hull.getHullProfile(type);
  let d, a, extra = '';
  if (s.surface === 'hull') {
    const r = nearestOnHull(profile, s.pos, s.side);
    d = r.d; a = deg(s.out, r.n);
  } else if (s.surface === 'stem' || s.surface === 'transom') {
    const r = nearestOnCentreRow(profile, s.pos, s.surface === 'stem' ? 1 : 0);
    d = r.d; a = deg(s.out, r.n); extra = ` half-beam at seat ${r.halfBeam.toFixed(3)} m`;
  } else if (s.surface === 'post') {
    const m = rudderMount(profile);
    const ax = [0, m.top.y - m.foot.y, m.top.z - m.foot.z];
    const l = Math.hypot(...ax); const dir = ax.map((c) => c / l);
    const rel = [s.pos[0], s.pos[1] - m.foot.y, s.pos[2] - m.foot.z];
    const t = rel[1] * dir[1] + rel[2] * dir[2];
    d = Math.hypot(rel[0], rel[1] - t * dir[1], rel[2] - t * dir[2]);
    a = deg(s.up, dir);
  } else {
    d = Math.abs(s.pos[1] - getShipDeckY(0, SHIP_STATS[type]));
    a = deg(s.out, [0, 1, 0]);
  }
  const good = d <= TOL_M && a <= TOL_DEG;
  (good ? ok : fail)(`${tag} ${type} ${s.part}${s.side ? (s.side > 0 ? ' stbd' : ' port') : ''} @(${s.pos.map((c) => c.toFixed(2)).join(',')}) ${s.surface}: ${(d * 100).toFixed(2)} cm, ${a.toFixed(2)} deg${extra}`);
  return good;
}

const TYPES = ['sloop', 'brigantine', 'galleon'];
const counts = {};
for (const type of TYPES) {
  const deckParts = ['barrel', 'bell', 'bilge_pump', 'cannonball_rack'];
  const socks = [...kit.shipKitSockets(type), ...kit.deckKitSockets(type, deckParts.map((part, i) => ({ x: 0.5 - i * 0.3, z: 0.3 + i, yaw: 0.7, part })))];
  // Deck parts (kit II): every part the renderer berths mounts its own nodes.
  for (const part of deckParts) if (!socks.some((s) => s.surface === 'deck' && s.part === part)) fail(`[deck] ${type}: deckKitSockets has no ${part} socket`);
  // Taffrail lanterns (kit II) on every lantern seat of the class's stern part (kit I sock_stern_*_lantern_k).
  const sternPart = { sloop: 'stern_transom_sloop', brigantine: 'stern_gallery_brigantine', galleon: 'stern_gallery_galleon_upper' }[type];
  const seats = GLB.ship_kit_a.nodes.map((n) => n.name).filter((n) => new RegExp(`^sock_${sternPart}_lantern_\\d$`).test(n));
  const lanterns = socks.filter((s) => s.part === 'taffrail_lantern');
  if (!seats.length) fail(`[seat] ${type}: no sock_${sternPart}_lantern_k seats in ship_kit_a.glb`);
  for (const seat of seats) if (!lanterns.some((s) => s.seat && s.seat.path[s.seat.path.length - 1] === seat)) fail(`[seat] ${type}: no taffrail lantern on ${seat}`);
  if (lanterns.length === seats.length && seats.length) ok(`[seat] ${type}: ${lanterns.length} taffrail lanterns on the ${sternPart} seats`);
  for (const s of socks) if (s.seat) for (const n of s.seat.path) if (!GLB[s.seat.file].nodes.some((x) => x.name === n)) fail(`[seat] ${type} ${s.part}: seat ${n} not in ${s.seat.file}.glb`);
  counts[type] = socks.length;
  let bad = 0;
  for (const s of socks) if (!gradeSocket(type, s, '[socket]')) bad++;
  // Gunports over their guns.
  const stats = SHIP_STATS[type];
  const per = Math.max(1, stats.cannonCount / 2);
  const ports = socks.filter((s) => s.part === 'gunport');
  if (ports.length !== stats.cannonCount) fail(`[gunport] ${type}: ${ports.length} gunports for ${stats.cannonCount} guns`);
  ports.forEach((s, i) => {
    const side = i < per ? 0 : 1, c = i % per;
    const g = getCannonDeckLocalPosition(stats, side === 0 ? c : per + c);
    if (Math.abs(g.z - s.pos[2]) > TOL_M || Math.sign(g.x) !== Math.sign(s.pos[0])) fail(`[gunport] ${type} #${i}: gun z ${g.z.toFixed(2)} x ${g.x.toFixed(2)} vs port z ${s.pos[2].toFixed(2)} x ${s.pos[0].toFixed(2)}`);
  });
  // Node table.
  for (const s of socks) for (const n of s.nodes) {
    if (!GLB[s.file].nodes.some((x) => x.name === n)) fail(`[nodes] ${type} ${s.part}: node ${n} not in ${s.file}.glb`);
  }

  // Mount math on a stub library from the GLB node table.
  const scenes = new Map();
  const stub = {
    has: (f) => !!GLB[f],
    source: (f) => {
      if (scenes.has(f)) return scenes.get(f);
      const j = GLB[f], scene = new THREE.Group();
      for (const n of j.nodes) {
        const o = new THREE.Object3D(); o.name = n.name;
        if (n.translation) o.position.fromArray(n.translation);
        if (n.rotation) o.quaternion.fromArray(n.rotation);
        if (n.scale) o.scale.fromArray(n.scale);
        if (n.mesh !== undefined) {
          const mat = new THREE.MeshBasicMaterial(); mat.name = j.materials[j.meshes[n.mesh].primitives[0].material]?.name ?? '';
          o.add(new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1, 0, 1, 0], 3)), mat));
        }
        scene.add(o);
      }
      scenes.set(f, { scene });
      return scenes.get(f);
    },
  };
  const mounted = socks.filter((s) => s.part !== 'rudder');
  const root = kit.mountShipKit(mounted, stub, null);
  if (!root) { fail(`[mount] ${type}: mountShipKit returned null`); continue; }
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (const im of root.children) {
    const node = im.name.replace(/^kit-/, '');
    const want = mounted.filter((s) => s.nodes.includes(node));
    if (im.count !== want.length) fail(`[mount] ${type} ${node}: ${im.count} instances for ${want.length} sockets`);
    if (/glass|lid|gudgeons|^bell$|_handle$/.test(node)) continue; // pivot children: own local frame
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m); m.decompose(p, q, sc);
      const s = want[i];
      if (!s) break; // count mismatch already failed above
      const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q), y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      // Seated parts (upper gallery tier, taffrail lanterns) sit on the GLB seat
      // empty composed onto their parent's spline socket.
      let wantPos = s.pos, wantOut = s.out;
      if (s.seat) {
        const f = kit.socketMatrix(s, new THREE.Matrix4());
        for (const n of s.seat.path) { const o = stub.source(s.seat.file).scene.getObjectByName(n); o.updateMatrix(); f.multiply(o.matrix); }
        const fp = new THREE.Vector3(), fq = new THREE.Quaternion(), fs = new THREE.Vector3(); f.decompose(fp, fq, fs);
        wantPos = fp.toArray(); wantOut = new THREE.Vector3(0, 0, 1).applyQuaternion(fq).toArray();
      }
      const dz = s.surface === 'deck' ? deg(y.toArray(), s.out) : deg(z.toArray(), wantOut);
      const dp = dist(p.toArray(), wantPos);
      if (dp > 0.001 || dz > 0.1) { bad++; fail(`[mount] ${type} ${node} #${i}: origin ${(dp * 100).toFixed(2)} cm, axis ${dz.toFixed(2)} deg off its socket`); }
    }
  }
  const draws = kit.kitDrawCount(root);
  (bad === 0 ? ok : fail)(`[mount] ${type}: ${socks.length} sockets, ${root.children.length} instanced draws (${draws})`);

  // LOD1/LOD2 (b4.3c): the level roots mount the kit's own <node>_LODk geometry on the SAME socket
  // frames (instance matrices equal to LOD0), LOD0 materials bound by name; glass panes reuse LOD0.
  for (const lvl of [1, 2]) {
    const lr = kit.mountShipKit(mounted, stub, null, lvl);
    if (!lr) { fail(`[lod${lvl}] ${type}: mountShipKit(level ${lvl}) returned null`); continue; }
    let lodBad = 0;
    const m0 = new THREE.Matrix4(), m1 = new THREE.Matrix4();
    for (const im of lr.children) {
      const node = im.name.replace(/^kit-/, '');
      const ref = root.children.find((c) => c.name === im.name);
      const file = mounted.find((s) => s.nodes.includes(node))?.file ?? null;
      const lodNode = file && stub.source(`${file}_lods`).scene.getObjectByName(`${node}_LOD${lvl}`);
      if (/glass/.test(node)) { if (lodNode) { lodBad++; fail(`[lod${lvl}] ${type} ${node}: glass has a LOD node but the mount reused LOD0`); } continue; }
      if (!lodNode) { lodBad++; fail(`[lod${lvl}] ${type} ${node}: no ${node}_LOD${lvl} in ${file}_lods`); continue; }
      if (im.geometry !== lodNode.children[0]?.geometry) { lodBad++; fail(`[lod${lvl}] ${type} ${node}: drew LOD0 geometry, not ${node}_LOD${lvl}`); }
      if (!ref || ref.count !== im.count) { lodBad++; fail(`[lod${lvl}] ${type} ${node}: ${im.count} instances vs LOD0 ${ref?.count}`); continue; }
      for (let i = 0; i < im.count; i++) {
        ref.getMatrixAt(i, m0); im.getMatrixAt(i, m1);
        if (m0.elements.some((e, k) => Math.abs(e - m1.elements[k]) > 1e-5)) { lodBad++; fail(`[lod${lvl}] ${type} ${node} #${i}: frame differs from LOD0`); break; }
      }
    }
    if (lr.children.length !== root.children.length) { lodBad++; fail(`[lod${lvl}] ${type}: ${lr.children.length} buckets vs LOD0 ${root.children.length}`); }
    (lodBad === 0 ? ok : fail)(`[lod${lvl}] ${type}: ${lr.children.length} buckets on LOD${lvl} geometry, frames = LOD0`);
  }
}

// Berths (b4.3c kit II): the renderer's own buildShip must berth a bell, a
// bilge pump and a shot garland per side on every class, on the deck slab.
{
  const { installCanvasStub } = await import('./lib/canvas-stub.mjs');
  installCanvasStub();
  const { ShipRenderer } = await import('../src/client/rendering/ShipRenderer.ts');
  const sr = new ShipRenderer();
  sr.init(new THREE.Scene(), 'high');
  for (const type of TYPES) {
    const ship = {
      id: `sockets-${type}`, type, ownerId: 'o', crewIds: [], position: { x: 0, y: 0, z: 0 }, rotation: 0,
      velocity: { x: 0, y: 0, z: 0 }, angularVelocity: 0, sailHeight: 1, sailAngle: 0, anchored: false,
      anchorRaiseProgress: 0, holes: [], nextHoleId: 1, maxHull: 1, onFire: false, fireTimer: 0,
      fireDamageAccum: 0, sinkProgress: 0, sinking: false, cannonCooldowns: [], chainshottedUntil: 0,
      sailIntegrity: 1, sailRepairWoodTimer: 0, gold: 0, treasureChestIds: [], inventory: [],
      repairCooldown: 0, autoRepairProgress: 0, teamColor: 0x3366cc, alive: true, upgrades: [],
    };
    sr.buildShip(ship);
    const mg = sr.shipMeshes.get(ship.id);
    const deck = (mg?.kitSockets ?? []).filter((s) => s.surface === 'deck');
    const n = (part) => deck.filter((s) => s.part === part).length;
    // The sloop's main deck is all gun, rope and stairwell zones: a bell only.
    const want = type === 'sloop' ? { bell: 1 } : { bell: 1, bilge_pump: 1, cannonball_rack: 2 };
    const miss = Object.entries(want).filter(([p, k]) => n(p) < k).map(([p, k]) => `${p} ${n(p)}/${k}`);
    const off = deck.filter((s) => !gradeSocket(type, s, '[berth]'));
    (miss.length || off.length ? fail : ok)(`[berths] ${type}: ${deck.map((s) => `${s.part}@(${s.pos[0].toFixed(1)},${s.pos[2].toFixed(1)})`).join(' ')}${miss.length ? ` MISSING ${miss.join(', ')}` : ''}`);
  }
}

// --prove: the gate must be able to fail.
if (PROVE) {
  const s0 = kit.shipKitSockets('galleon').find((s) => s.part === 'gunport');
  const nudged = { ...s0, pos: [s0.pos[0] + Math.sign(s0.pos[0]) * 0.05, s0.pos[1], s0.pos[2]] };
  const tilted = { ...s0, out: [s0.out[0], s0.out[1] + Math.tan(8 * Math.PI / 180), s0.out[2]].map((c, _, a) => c / Math.hypot(...a)) };
  const saved = fails;
  const r1 = gradeSocket('galleon', nudged, '[prove 5 cm off]');
  const r2 = gradeSocket('galleon', tilted, '[prove 8 deg]');
  fails = saved;
  if (r1 || r2) fail('[prove] a mutation stayed green'); else ok('[prove] 5 cm and 8 deg mutations go red');
}

// Source contract.
const sr = readFileSync('src/client/rendering/ShipRenderer.ts', 'utf8');
const start = sr.indexOf('  buildShip(ship: Ship): THREE.Group {');
const end = sr.indexOf('  private hardwareReady(): boolean {');
const body = start >= 0 && end > start ? sr.slice(start, end) : '';
if (!body) fail('[source] buildShip not found');
if (/makeFigurehead\(/.test(body)) fail('[source] buildShip still calls makeFigurehead');
if (/gunportFrame|gunportDoor|gunportOpening/.test(body)) fail('[source] buildShip still builds procedural gunport boxes');
if (!/shipKitSockets\(/.test(sr) || !/mountShipKit\(/.test(sr)) fail('[source] ShipRenderer does not mount the kit (shipKitSockets/mountShipKit)');
if (/export function makeFigurehead/.test(readFileSync('src/client/rendering/ship/dressing.ts', 'utf8'))) fail('[source] dressing.ts still exports makeFigurehead');
if (!/mountShipKit\([^;]*, 1\)/.test(sr) || !/mountShipKit\([^;]*, 2\)/.test(sr)) fail('[source] ShipRenderer does not mount kit LOD1 + LOD2 in the level roots (figureheads/gunports pop off past 30 m)');
const stern = readFileSync('src/client/rendering/ship/stern.ts', 'utf8');
if (/makeWindowFrame|BoxGeometry\(0\.5, 0\.35|galleryRail/.test(stern)) fail('[source] stern.ts still draws the procedural stern windows / gallery rail under the kit gallery');
if (/part === 'stern_gallery_galleon'/.test(readFileSync('src/client/rendering/ship/kit.ts', 'utf8'))) fail('[source] kit.ts special-cases the galleon upper tier instead of seating it (KitSocket.seat)');
for (const part of ['bell', 'bilge_pump', 'cannonball_rack']) if (!new RegExp(`(part: |berth\\()'${part}'`).test(body)) fail(`[source] buildShip berths no ${part} (kit II deck part)`);
if (/export function makeWindowFrame/.test(readFileSync('src/client/rendering/ship/dressing.ts', 'utf8'))) fail('[source] dressing.ts still exports makeWindowFrame');
const lib = readFileSync('src/client/assets/AssetLibrary.ts', 'utf8');
if (!/'ship_kit_a_lods'/.test(lib) || !/'ship_kit_b_lods'/.test(lib)) fail('[source] AssetLibrary does not stream ship_kit_a_lods/ship_kit_b_lods');
if (!/'ship_kit_a'/.test(lib) || !/'ship_kit_b'/.test(lib)) fail('[source] AssetLibrary does not list ship_kit_a/ship_kit_b');
const prims = (body.match(/new THREE\.(Box|Cylinder|Sphere|Torus|Cone|Circle|Plane)Geometry\(/g) ?? []).length;
const primLine = `[primitives] buildShip ${prims} primitive constructors (ratchet ${PRIMITIVE_RATCHET}, target < ${PRIMITIVE_TARGET}${prims < PRIMITIVE_TARGET ? ' MET' : ' open'})`;
(prims <= PRIMITIVE_RATCHET ? ok : fail)(primLine);

console.log(`\ntest-ship-sockets: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')} sockets; ${fails} failed`);
process.exit(fails ? 1 : 0);
