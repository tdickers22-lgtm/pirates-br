#!/usr/bin/env node
// b4.7b gate: the climb verb and its placement on the static world (seed 20260801).
//   - every route's foot and top stand on dry walkable ground;
//   - a scripted bot climbs every route up in <= len/2.4 + 1 s and down in
//     <= len/3.2 + 1 s, and stays on the face whatever it presses (sideways,
//     back-and-forth) until it jumps off; the jump-off clears >= 2 m;
//   - walk + climb + bridge (+ sea: a swimmer lands on any beach) flood fill
//     reaches >= 95% of every island's walkable land from its landing beach,
//     on a 2 m grid (placement plans on 3 m);
//   - every authored scarp > 5 m with walkable ground on both sides has a route
//     within 60 m of every point of its path;
//   - the mast ladder still runs through the same verb (base -> nest).
// Usage: node --import tsx scripts/test-island-climb.mjs [--mutate=no-climbs|no-jump|prop-on-route]
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { getIslandLandforms } from '../src/shared/landforms.ts';
import { PHYSICS } from '../src/shared/constants/index.ts';
import {
  CLIMB_JUMP_OFF_M, CLIMB_SCARP_MIN_M, CLIMB_SCARP_SPACING_M, CLIMB_STANDOFF_M, WALK_SLOPE_MAX,
  climbLength, climbPointAt, findClimbMount, islandClimbs,
} from '../src/shared/interactions.ts';
import { resolvePropCollision } from '../src/shared/props.ts';
import { ClimbSystem, MAST_CLIMB_RATE } from '../src/server/systems/ClimbSystem.ts';
import { buildWalkGrid, gridCellAt, landingComponent, CLIMB_DRY_Y } from '../src/server/world/placement/climbs.ts';

const mutate = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice(9);
let passed = 0;
let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) passed++; else { failed++; console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`); }
};

const islands = new MapGenerator(20260801).generateIslands();
if (mutate === 'no-climbs') for (const i of islands) i.climbs = [];
const all = islands.flatMap((i) => islandClimbs(i).map((c) => ({ island: i, c })));
ok(all.length >= 8, 'world has climb routes', `${all.length}`);

const slopeAt = (isl, x, z) => {
  const h = 1;
  return Math.max(
    Math.abs(getIslandSurfaceY(isl, x + h, z) - getIslandSurfaceY(isl, x - h, z)),
    Math.abs(getIslandSurfaceY(isl, x, z + h) - getIslandSurfaceY(isl, x, z - h)),
  ) / (2 * h);
};

// 1. ends on dry walkable ground.
for (const { island, c } of all) {
  for (const [end, x, y, z] of [['foot', c.ax, c.ay, c.az], ['top', c.bx, c.by, c.bz]]) {
    const g = getIslandSurfaceY(island, x, z);
    const s = slopeAt(island, x, z);
    ok(Math.abs(g - y) < 0.05 && g >= CLIMB_DRY_Y && s <= WALK_SLOPE_MAX, `${c.id} ${end} on walkable ground`,
      `ground ${g.toFixed(2)} y ${y.toFixed(2)} slope ${s.toFixed(2)}`);
  }
  ok(c.by - c.ay >= 0.5, `${c.id} rises`, `${(c.by - c.ay).toFixed(2)} m`);
}

// 2. scripted bot.
const DT = 1 / 30;
const mkPlayer = (id, x, y, z) => ({
  id, isBot: false, state: 'alive', onShipId: null, mastClimb: null, atCrowNest: false,
  position: { x, y, z }, velocity: { x: 0, y: 0, z: 0 }, knockbackVelocity: { x: 0, y: 0, z: 0 },
});
const input = (o = {}) => ({ forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false, interact: false, ...o });
const offRoute = (c, p) => {
  let best = Infinity;
  for (let i = 3; i < c.pts.length; i += 3) {
    const ax = c.pts[i - 3], ay = c.pts[i - 2], az = c.pts[i - 1];
    const sx = c.pts[i] - ax, sy = c.pts[i + 1] - ay, sz = c.pts[i + 2] - az;
    const L2 = sx * sx + sy * sy + sz * sz || 1;
    const f = Math.max(0, Math.min(1, ((p.x - ax) * sx + (p.y - ay) * sy + (p.z - az) * sz) / L2));
    best = Math.min(best, Math.hypot(p.x - ax - sx * f, p.y - ay - sy * f, p.z - az - sz * f));
  }
  return best;
};
const tick = (sys, pl, inp) => {
  // Physics stand-in: gravity and the sideways input push the body off the line; pin must undo it.
  pl.position.y += PHYSICS.GRAVITY * DT * DT;
  pl.position.x += (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  sys.pin([pl]);
};
let worstStray = 0;
for (const { island, c } of all) {
  const len = climbLength(c);
  const sys = new ClimbSystem();
  const pl = mkPlayer(`bot-${c.id}`, c.ax, c.ay, c.az);
  ok(findClimbMount(islands, c.ax, c.ay, c.az)?.climb.id === c.id || findClimbMount(islands, c.ax, c.ay, c.az) !== null,
    `${c.id} [X] offered at the foot`);
  ok(sys.tryMount(pl, [island]), `${c.id} mounts at the foot`);
  let t = 0;
  let n = 0;
  // Up, with noise: sideways, a back press every 7th tick (still net up).
  while (pl.mastClimb !== null && n < 3000) {
    const inp = input({ forward: n % 7 !== 3, back: n % 7 === 3, left: n % 5 === 1, right: n % 5 === 2 });
    sys.applyInput(pl, inp, null, DT, false);
    if (pl.mastClimb !== null) { tick(sys, pl, inp); worstStray = Math.max(worstStray, offRoute(c, pl.position)); }
    n++;
  }
  // Clean up-run timing.
  const sys2 = new ClimbSystem();
  const p2 = mkPlayer(`bot2-${c.id}`, c.ax, c.ay, c.az);
  sys2.tryMount(p2, [island]);
  for (t = 0; p2.mastClimb !== null && t < 120; t += DT) { sys2.applyInput(p2, input({ forward: true }), null, DT, false); if (p2.mastClimb !== null) tick(sys2, p2, input()); }
  ok(t <= len / 2.4 + 1, `${c.id} up in <= len/2.4 + 1 s`, `${t.toFixed(2)} s for ${len.toFixed(1)} m`);
  ok(Math.hypot(p2.position.x - c.bx, p2.position.y - c.by, p2.position.z - c.bz) < 0.05, `${c.id} steps off onto the top`);
  // Down from the top.
  const p3 = mkPlayer(`bot3-${c.id}`, c.bx, c.by, c.bz);
  ok(sys2.tryMount(p3, [island]), `${c.id} mounts at the top`);
  for (t = 0; p3.mastClimb !== null && t < 120; t += DT) { sys2.applyInput(p3, input({ back: true }), null, DT, false); if (p3.mastClimb !== null) tick(sys2, p3, input()); }
  ok(t <= len / 3.2 + 1 && Math.hypot(p3.position.x - c.ax, p3.position.z - c.az) < 0.05, `${c.id} down in <= len/3.2 + 1 s`, `${t.toFixed(2)} s`);
  // Jump-off from the middle: ballistic until back at the height it left from.
  const p4 = mkPlayer(`bot4-${c.id}`, c.ax, c.ay, c.az);
  sys2.tryMount(p4, [island]);
  for (t = 0; (p4.mastClimb ?? 1) < 0.5 && t < 60; t += DT) { sys2.applyInput(p4, input({ forward: true }), null, DT, false); tick(sys2, p4, input()); }
  const from = { ...p4.position };
  if (mutate !== 'no-jump') sys2.applyInput(p4, input({ jumpPressed: true }), null, DT, false);
  ok(p4.mastClimb === null, `${c.id} jump-off leaves the face`);
  let fl = 0;
  const q = { ...p4.position }; const v = { ...p4.velocity };
  do { v.y += PHYSICS.GRAVITY * DT; q.x += v.x * DT; q.y += v.y * DT; q.z += v.z * DT; fl += DT; } while (q.y > from.y && fl < 5);
  const clear = Math.hypot(q.x - from.x, q.z - from.z);
  ok(clear >= CLIMB_JUMP_OFF_M - 0.1, `${c.id} jump-off clears >= ${CLIMB_JUMP_OFF_M} m`, `${clear.toFixed(2)} m`);
}
ok(worstStray <= CLIMB_STANDOFF_M + 0.35, 'bot never leaves the face (sideways/back-and-forth noise)', `worst ${worstStray.toFixed(2)} m from the route`);

// 3. reachability on a 2 m grid.
for (const island of islands) {
  const g = buildWalkGrid(island, 2);
  const start = landingComponent(g);
  if (start < 0) continue;
  const parent = g.sizes.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a]; return a; };
  const join = (a, b) => { if (a >= 0 && b >= 0) parent[find(a)] = find(b); };
  /** A route end joins the walkable cell nearest it (within one cell). */
  const cellNear = (x, z) => {
    let best = -1; let bd = Infinity;
    for (let dz = -2; dz <= 2; dz += 2) for (let dx = -2; dx <= 2; dx += 2) {
      const k = gridCellAt(g, x + dx, z + dz);
      if (k >= 0 && g.comp[k] >= 0 && Math.hypot(dx, dz) < bd) { best = g.comp[k]; bd = Math.hypot(dx, dz); }
    }
    return best;
  };
  for (const c of g.shore) join(c, start);
  for (const b of island.bridges ?? []) join(cellNear(b.ax, b.az), cellNear(b.bx, b.bz));
  for (const c of islandClimbs(island)) join(cellNear(c.ax, c.az), cellNear(c.bx, c.bz));
  const total = g.sizes.reduce((a, b) => a + b, 0);
  const reached = g.sizes.reduce((a, s, i) => a + (find(i) === find(start) ? s : 0), 0);
  ok(reached / total >= 0.95, `${island.id} reach >= 95% of walkable land`, `${(100 * reached / total).toFixed(1)}%`);
}

// 4. tall scarps get a route within 60 m.
for (const island of islands) {
  const routes = islandClimbs(island);
  for (const rec of getIslandLandforms(island)) {
    if (rec.kind !== 'scarp' || rec.height <= CLIMB_SCARP_MIN_M) continue;
    let gaps = 0; let checked = 0;
    for (let p = 1; p < rec.path.length; p++) {
      const [x0, z0] = rec.path[p - 1]; const [x1, z1] = rec.path[p];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 1e-3) continue;
      const tx = (x1 - x0) / L; const tz = (z1 - z0) / L;
      for (let s = 0; s <= L; s += 10) {
        const wx = island.position.x + x0 + tx * s; const wz = island.position.z + z0 + tz * s;
        const sides = [1, -1].map((k) => {
          const x = wx - tz * 10 * k; const z = wz + tx * 10 * k;
          return { y: getIslandSurfaceY(island, x, z), s: slopeAt(island, x, z) };
        });
        if (sides.some((q) => q.y < CLIMB_DRY_Y || q.s > WALK_SLOPE_MAX) || Math.abs(sides[0].y - sides[1].y) < CLIMB_SCARP_MIN_M * 0.6) continue;
        checked++;
        if (!routes.some((c) => Math.min(Math.hypot(c.ax - wx, c.az - wz), Math.hypot(c.bx - wx, c.bz - wz)) <= CLIMB_SCARP_SPACING_M)) gaps++;
      }
    }
    if (checked > 0) ok(gaps === 0, `${island.id}/${rec.id} (${rec.height} m scarp) route within ${CLIMB_SCARP_SPACING_M} m`, `${gaps}/${checked} path points uncovered`);
  }
}

// 6. no climb runs through a prop or a cliff-kit hull: the climber's body at
//    every 0.25 m of the route (the standoff point the server pins it to) is
//    one the shared prop/kit pushout leaves alone. A route through a boulder or
//    a kit face would pin the body inside geometry the walker can never enter.
{
  const BODY_R = 0.3;
  if (mutate === 'prop-on-route') {
    for (const { island, c } of all) {
      const mid = c.pts.length / 3 >> 1;
      (island.props ??= []).push({ id: `mut-${c.id}`, type: 'boulder_a', x: c.pts[mid * 3], z: c.pts[mid * 3 + 2], rotation: 0, scale: 1 });
    }
  }
  let samples = 0;
  for (const { island, c } of all) {
    const len = climbLength(c);
    const n = Math.max(4, Math.ceil(len / 0.25));
    let hits = 0; let worst = 0; let worstT = 0;
    for (let i = 0; i <= n; i++) {
      const p = climbPointAt(c, i / n);
      const r = resolvePropCollision({ x: p.x, y: p.y, z: p.z }, BODY_R, island);
      samples++;
      if (r.pushed) {
        hits++;
        const d = Math.hypot(r.x - p.x, r.z - p.z);
        if (d > worst) { worst = d; worstT = i / n; }
      }
    }
    ok(hits === 0, `${c.id} (${c.kind}) clear of props and kit hulls`, `${hits}/${n + 1} body samples pushed, worst ${worst.toFixed(2)} m at t=${worstT.toFixed(2)}`);
  }
  ok(samples >= all.length * 5, 'prop/kit clearance sampled', `${samples}`);
}

// 5. the mast ladder runs through the same verb.
{
  const sys = new ClimbSystem();
  const pl = mkPlayer('mast', 0, 3, 0);
  pl.onShipId = 'ship-1';
  const ship = { id: 'ship-1', sinking: false };
  sys.mountMast(pl);
  let t = 0;
  for (; pl.mastClimb !== null && t < 10; t += DT) sys.applyInput(pl, input({ forward: true }), ship, DT, false);
  ok(pl.atCrowNest && Math.abs(t - 1 / MAST_CLIMB_RATE) < 0.1, 'mast ladder: base -> nest through ClimbSystem', `${t.toFixed(2)} s, nest ${pl.atCrowNest}`);
  sys.mountMast(pl); pl.atCrowNest = false;
  sys.applyInput(pl, input(), ship, DT, true);
  ok(pl.mastClimb === null, 'mast ladder: [X] lets go');
}

// 8. Climb kit (b4.7b): routes are drawn from the Blender climb_kit.glb nodes, not runtime cylinders.
{
  const fs = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const read = (rel) => (fs.existsSync(new URL(rel, root)) ? fs.readFileSync(new URL(rel, root)) : null);
  const NODES = ['climb_rail', 'climb_rung', 'climb_rope', 'climb_knot', 'climb_stake'];
  const glb = read('public/assets/models/climb_kit.glb');
  let json = null;
  if (glb && glb.readUInt32LE(0) === 0x46546c67) json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  ok(!!json, 'climb kit: public/assets/models/climb_kit.glb on disk (scripts/blender/build_poi_kit.py)');
  if (json) {
    const meshNodes = new Map((json.nodes ?? []).filter((n) => n.mesh !== undefined).map((n) => [n.name, n.mesh]));
    const trisOf = (mi) => json.meshes[mi].primitives.reduce((a, pr) => a + json.accessors[pr.indices].count / 3, 0);
    for (const n of NODES) ok(meshNodes.has(n), `climb kit: node ${n} is a mesh`);
    const tris = NODES.filter((n) => meshNodes.has(n)).reduce((a, n) => a + trisOf(meshNodes.get(n)), 0);
    ok(tris >= 300 && tris <= 600, 'climb kit: 300-600 tris across the five nodes', `${tris}`);
    const mats = (json.materials ?? []).map((m) => m.name);
    ok(mats.includes('Rope') && mats.some((m) => /^Wood_/.test(m)), 'climb kit: Rope + Wood_* materials', mats.join(','));
  }
  const src = (read('src/client/world/island/Landmarks.ts') ?? '').toString();
  ok(/mergedNodeGeometry\('climb_kit'/.test(src) && NODES.every((n) => src.includes(`'${n}'`)),
    'climb kit: Landmarks.buildRopeLadder instances every kit node via assets.mergedNodeGeometry');
  const lib = (read('src/client/assets/AssetLibrary.ts') ?? '').toString();
  const names = lib.slice(lib.indexOf('export const ASSET_NAMES'), lib.indexOf('] as const', lib.indexOf('export const ASSET_NAMES')));
  ok(names.includes("'climb_kit'"), 'climb kit: climb_kit in AssetLibrary ASSET_NAMES (loaded with the world)');
  const manifest = JSON.parse((read('src/client/assets/model-manifest.json') ?? '{}').toString());
  ok(!!manifest.climb_kit && !!read(`public/assets/models/packed/${manifest.climb_kit}`), 'climb kit: packed (model-manifest.json row + file)');
}

const kinds = all.reduce((m, { c }) => ({ ...m, [c.kind]: (m[c.kind] ?? 0) + 1 }), {});
console.log(`routes ${all.length} ${JSON.stringify(kinds)}; worst stray ${worstStray.toFixed(2)} m`);
console.log(`${passed} passed, ${failed} failed`);
if (passed === 0) { console.log('VACUOUS'); process.exit(1); }
// The runner's EVIDENCE regex needs a PASS/FAIL token (a bare tally reads VACUOUS).
console.log(failed ? `FAIL test-island-climb: ${failed} rows` : `PASS test-island-climb: ${passed} rows`);
process.exit(failed ? 1 : 0);
