// test-bot-island-reach (b4.4h, islands-01 / vm:islands:2): a bot pirate
// reaches >= 90% of the walkable land of every island from its landing beach,
// so the b4.4e-h scarps, cliffs, mesas and calderas never wall a crew off.
//
//   node --import tsx scripts/test-bot-island-reach.mjs [--report] [--mutate=wall-beach]
//
// Part A (walk graph, all 14 islands): a 1 m grid over the shared terrain truth
//   getIslandSurfaceY. LAND = inside the footprint and above the swim line.
//   WALKABLE = land whose local gradient is under the physics climb limit
//   (PhysicsSystem LOCO.SLOPE_MAX 1.15: what a pirate can stand on and walk up).
//   Edges are 4-neighbour steps with the exact rule resolveSlopeBlock applies:
//   an UPHILL rise/run over SLOPE_MAX is refused, any DOWNHILL step is taken (a
//   pirate can always drop off a ledge; fall damage is capped, not lethal).
//   Rope bridges are edges both ways. Mesa ladder sites (getLandformLadders) are
//   NOT edges: nothing in src climbs them yet, and a gate must not credit a
//   route the game does not have. Cave interiors are out of scope (test-cave-walk).
//   Seed = the landing beach: the walkable cell nearest the dock respawn point;
//   an undocked island lands on its widest climb-out beach (see seedCells).
//   Props: a cell inside a prop collider (BODY_R probe) is neither land nor a
//   route. Edge climb limit EDGE_SLOPE 1.0 (SLOPE_MAX less a probe margin).
//   Swim layer: from any land cell a pirate may drop into the sea and swim; she
//   climbs out only onto ground <= CLIMB_OUT_Y (a beach, not a sea cliff).
//   PASS per island: walkable reached (foot + swim) / walkable >= 0.90; the
//   on-foot share is printed beside it.
// Part B (server physics, all 14 islands): a pirate driven through the REAL
//   PhysicsSystem from the landing beach along the Part A route to 8 targets
//   spread over the reached land (farthest-point sampling), steering waypoint
//   to waypoint at run speed, jumping (PLAYER.JUMP_FORCE) after 0.8 s without
//   progress like a player would; every lip that needed a jump is printed.
//   Stuck = under 0.6 m of progress in 2.5 s. Every
//   stuck position is printed. PASS per island: >= 7/8 targets arrived (2.5 m),
//   never flipped to swimming on the way.
// --mutate=wall-beach: a 14 m vertical scarp is raised 8 m inland of every dock
//   across the whole island (overrideIslandLandforms); Part A must FAIL on every
//   docked island (measured: 20 FAIL, reach 0.3-0.5%). Part B only drives to
//   land Part A reached, so it is the physics cross-check, not the RED proof.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import {
  getIslandSurfaceY, getIslandMaxRadius, getTavernWallBand, pushOutOfTavernWalls, toTavernLocal,
} from '../src/shared/utils/index.ts';
import { getIslandLandforms, overrideIslandLandforms } from '../src/shared/landforms.ts';
import { PLAYER } from '../src/shared/constants/index.ts';
import { resolvePropCollision } from '../src/shared/props.ts';

const REPORT = process.argv.includes('--report');
const MUT = (process.argv.find((a) => a.startsWith('--mutate=')) ?? '').slice(9);
const SLOPE_MAX = 1.15; // PhysicsSystem LOCO.SLOPE_MAX
const LAND_MIN_Y = 0.5; // swim line: wave ~0 + 0.32 water surface, plus margin
const EDGE_SLOPE = 1.0; // edge climb limit: SLOPE_MAX less a margin for the 1.05 m probe's aliasing
const CLIMB_OUT_Y = 1.4; // a swimmer wades out onto ground this low
const BODY_R = 0.45; // prop collider probe radius (a pirate's body)
const CELL = 1;
const REACH_MIN = 0.9;
const TARGETS = 8;
const ARRIVE_MIN = 7;

const islands = new MapGenerator(20260801).generateIslands();
let failures = 0;
const expect = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ''}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

if (MUT === 'wall-beach') {
  for (const isl of islands) {
    if (!isl.dock) continue;
    const dx0 = isl.position.x - isl.dock.respawnPoint.x, dz0 = isl.position.z - isl.dock.respawnPoint.z;
    const dl = Math.hypot(dx0, dz0) || 1;
    const d = { x: dx0 / dl, z: dz0 / dl };
    const c = { x: isl.dock.respawnPoint.x - isl.position.x + d.x * 8, z: isl.dock.respawnPoint.z - isl.position.z + d.z * 8 };
    const perp = { x: d.z, z: -d.x }; // cross(perp, d) = +1: the inland side is the HIGH side
    const L = 400;
    const wall = {
      id: 'mutate-wall-beach', kind: 'scarp', height: 14, face: 0.6, reach: 600, taper: 1,
      path: [[c.x - perp.x * L, c.z - perp.z * L], [c.x + perp.x * L, c.z + perp.z * L]],
    };
    overrideIslandLandforms(isl, [wall, ...getIslandLandforms(isl)]);
  }
  console.log('[mutate=wall-beach] 14 m scarp raised 8 m inland of every dock');
}
// --mutate=no-rim-trail: Old Maw without its rim trail (Part C must go RED).
if (MUT === 'no-rim-trail') {
  const om = islands.find((i) => i.id === 'old-maw-caldera');
  overrideIslandLandforms(om, getIslandLandforms(om).filter((r) => r.id !== 'old-maw-rim-trail'));
  console.log('[mutate=no-rim-trail] old-maw-rim-trail removed');
}

/** Part C (b4.4h detail POIs): reached cells within `r` of a local point. */
function reachedNear(island, g, parent, lx, lz, r, pred = () => true) {
  let n = 0, hit = 0;
  for (let dz = -r; dz <= r; dz += CELL) for (let dx = -r; dx <= r; dx += CELL) {
    if (dx * dx + dz * dz > r * r) continue;
    const k = cellOf(g, island.position.x + lx + dx, island.position.z + lz + dz);
    if (k < 0 || !g.walk[k] || !pred(k, Math.hypot(dx, dz))) continue;
    n++; if (parent[k] !== -2) hit++;
  }
  return { n, hit };
}
const findRec = (island, id) => getIslandLandforms(island).find((r) => r.id === id);
const localOf = (island, p) => [p.x - island.position.x, p.z - island.position.z];

function makePlayer(position) {
  return {
    id: 'reach-bot', name: 'ReachBot', shipId: null, position: { ...position },
    rotation: { x: 0, y: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: PLAYER.MAX_HEALTH, state: 'alive', weapons: [], activeSlot: 0,
    reloading: false, reloadTimer: 0, knockbackVelocity: { x: 0, y: 0, z: 0 },
    isBot: true, kills: 0, playerKillStreak: 0, superCannonballs: 0, megaKegs: 0,
    tsunamiCharges: 0, gold: 0, carryingChestId: null, treasureMapIslandId: null,
    swimTimer: 0, atCannon: false, atHelm: false, sailControlMode: null,
    atCrowNest: false, blocking: false, cutlassCharge: 0, cannonIndex: 0,
    nearChestId: null, nearShipId: null, onShipId: null, respawnTimer: 0,
    respawnProtectionTimer: 0, shipBoundaryGraceTimer: 0, lastDamagedById: null,
    lastDamagedAt: null, lastDamageWasHeadshot: false, selectedCannonAmmo: 'cannonball',
    kegs: 0, kegCooldown: 0, cannonFlightTimer: 0, cannonBallistic: false,
    pocketBanana: 0, pocketWood: 0, pocketCoconut: 0, pocketMango: 0, pocketMeat: 0,
    pocketUseCooldown: 0, hasShovel: false, nearBarrelId: null,
  };
}

/** resolvePlayerTavernCollision's test: inside the tavern's wall band and
 *  within a body radius of a wall (doorways stay open). */
function inTavernWall(island, x, y, z, r = BODY_R) {
  const tv = island.tavern;
  if (!tv) return false;
  const band = getTavernWallBand(tv);
  if (y < band.minY || y > band.maxY) return false;
  const local = toTavernLocal(tv, x, z);
  return pushOutOfTavernWalls(tv, local.x, local.z, r).pushed;
}

function buildGraph(island) {
  // The terrain runs on past the gameplay footprint (Kraken Tooth's footprint
  // edge stands 3-16 m above the sea), so LAND is decided by the surface alone
  // over a square wide enough that its rim is open sea (asserted below).
  const R = Math.ceil(getIslandMaxRadius(island) * 1.3 + 24);
  const x0 = island.position.x - R, z0 = island.position.z - R;
  const N = Math.ceil((2 * R) / CELL) + 1;
  const y = new Float32Array(N * N);
  const land = new Uint8Array(N * N);
  const prop = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = x0 + i * CELL, z = z0 + j * CELL;
      const k = j * N + i;
      const h = getIslandSurfaceY(island, x, z);
      y[k] = h;
      if (h < LAND_MIN_Y) continue;
      // Inside a prop collider (rock, wall, hut) is neither land to stand on
      // nor a route: the physics shoves the body out of it.
      if (resolvePropCollision({ x, y: h, z }, BODY_R, island).pushed || inTavernWall(island, x, h, z)) { prop[k] = 1; continue; }
      land[k] = 1;
    }
  }
  const walk = new Uint8Array(N * N);
  let walkable = 0;
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      if (!land[k]) continue;
      const gx = (y[k + 1] - y[k - 1]) / (2 * CELL), gz = (y[k + N] - y[k - N]) / (2 * CELL);
      if (Math.hypot(gx, gz) <= SLOPE_MAX) { walk[k] = 1; walkable++; }
    }
  }
  let rimLand = 0;
  for (let t = 0; t < N; t++) rimLand += land[t] + land[(N - 1) * N + t] + land[t * N] + land[t * N + N - 1];
  return { N, x0, z0, y, land, prop, walk, walkable, rimLand };
}

const cellOf = (g, x, z) => {
  const i = Math.round((x - g.x0) / CELL), j = Math.round((z - g.z0) / CELL);
  return (i < 0 || j < 0 || i >= g.N || j >= g.N) ? -1 : j * g.N + i;
};
const cellXZ = (g, k) => [g.x0 + (k % g.N) * CELL, g.z0 + Math.floor(k / g.N) * CELL];

/** Landing beach seeds. Docked island: the walkable cell nearest the dock
 *  respawn point. Undocked island (Dead Man Shoals, Kraken Tooth, Gallows Sands,
 *  Widow's Watch): the island's WIDEST beach, i.e. the largest 4-connected run
 *  of walkable cells under BEACH_MAX_Y that touch the sea, where a crew runs
 *  its boat up. Returns [] when there is none (the island then FAILS). */
const BEACH_MAX_Y = 2.5;
function seedCells(island, g) {
  if (island.dock) {
    const rp = island.dock.respawnPoint;
    let best = -1, bd = Infinity;
    for (let k = 0; k < g.N * g.N; k++) {
      if (!g.walk[k]) continue;
      const [x, z] = cellXZ(g, k);
      const d = Math.hypot(x - rp.x, z - rp.z);
      if (d < bd) { bd = d; best = k; }
    }
    return bd <= 14 ? { cells: [best], label: 'dock' } : { cells: [], label: 'dock (no walkable cell within 14 m)' };
  }
  const N = g.N;
  const beach = new Uint8Array(N * N);
  for (let k = N; k < N * N - N; k++) {
    if (!g.walk[k] || g.y[k] > CLIMB_OUT_Y) continue;
    const i = k % N;
    if (i === 0 || i === N - 1) continue;
    const water = (m) => !g.land[m] && !g.prop[m];
    if (water(k - 1) || water(k + 1) || water(k - N) || water(k + N)) beach[k] = 1;
  }
  // Grow the shoreline cells one step inland so a beach reads as a band.
  const band = beach.slice();
  for (let k = N; k < N * N - N; k++) {
    if (beach[k] || !g.walk[k] || g.y[k] > BEACH_MAX_Y) continue;
    if (beach[k - 1] || beach[k + 1] || beach[k - N] || beach[k + N]) band[k] = 1;
  }
  const seen = new Uint8Array(N * N);
  let bestComp = [];
  for (let s0 = 0; s0 < N * N; s0++) {
    if (!band[s0] || seen[s0]) continue;
    const comp = [], stack = [s0]; seen[s0] = 1;
    while (stack.length) {
      const k = stack.pop(); comp.push(k);
      for (const m of [k - 1, k + 1, k - N, k + N]) {
        if (m < 0 || m >= N * N || seen[m] || !band[m]) continue;
        seen[m] = 1; stack.push(m);
      }
    }
    if (comp.length > bestComp.length) bestComp = comp;
  }
  if (!bestComp.length) return { cells: [], label: 'no beach' };
  let cx = 0, cz = 0;
  for (const k of bestComp) { const [x, z] = cellXZ(g, k); cx += x; cz += z; }
  cx /= bestComp.length; cz /= bestComp.length;
  return { cells: bestComp, label: `widest beach ${bestComp.length} m² @(${(cx - island.position.x).toFixed(0)},${(cz - island.position.z).toFixed(0)})` };
}

function flood(island, g, seeds, swim = false) {
  const parent = new Int32Array(g.N * g.N).fill(-2);
  const queue = new Int32Array(g.N * g.N);
  let qh = 0, qt = 0;
  for (const sd of seeds) { parent[sd] = -1; queue[qt++] = sd; }
  const bridgeLinks = new Map();
  for (const b of island.bridges ?? []) {
    const a = cellOf(g, b.ax, b.az), c = cellOf(g, b.bx, b.bz);
    if (a < 0 || c < 0) continue;
    if (!bridgeLinks.has(a)) bridgeLinks.set(a, []);
    if (!bridgeLinks.has(c)) bridgeLinks.set(c, []);
    bridgeLinks.get(a).push(c); bridgeLinks.get(c).push(a);
  }
  const N = g.N;
  while (qh < qt) {
    const k = queue[qh++];
    const i = k % N, j = (k - i) / N;
    const nb = [];
    if (i > 0) nb.push(k - 1);
    if (i < N - 1) nb.push(k + 1);
    if (j > 0) nb.push(k - N);
    if (j < N - 1) nb.push(k + N);
    for (const n of bridgeLinks.get(k) ?? []) nb.push(n);
    const fromWater = !g.land[k];
    for (const n of nb) {
      if (parent[n] !== -2 || g.prop[n]) continue;
      if (!g.land[n]) {
        // Water: only the swim flood enters it (drop in off any shore).
        if (!swim) continue;
        parent[n] = k; queue[qt++] = n; continue;
      }
      if (fromWater) {
        if (g.y[n] > CLIMB_OUT_Y) continue; // no climbing out up a sea cliff
        parent[n] = k; queue[qt++] = n; continue;
      }
      const [ax, az] = cellXZ(g, k), [bx, bz] = cellXZ(g, n);
      const run = Math.hypot(bx - ax, bz - az);
      const isBridge = run > CELL * 1.01;
      if (!isBridge && (g.y[n] - g.y[k]) / run > EDGE_SLOPE) continue;
      parent[n] = k; queue[qt++] = n;
    }
  }
  let reached = 0;
  for (let k = 0; k < N * N; k++) if (g.walk[k] && parent[k] !== -2) reached++;
  return { parent, reached };
}

/** Unreached walkable pockets, largest first (4-connected components). */
function pockets(g, parent) {
  const seen = new Uint8Array(g.N * g.N);
  const out = [];
  for (let s = 0; s < g.N * g.N; s++) {
    if (!g.walk[s] || parent[s] !== -2 || seen[s]) continue;
    const stack = [s]; seen[s] = 1;
    let n = 0, sx = 0, sz = 0, sy = 0;
    while (stack.length) {
      const k = stack.pop();
      const [x, z] = cellXZ(g, k);
      n++; sx += x; sz += z; sy += g.y[k];
      const i = k % g.N;
      for (const m of [i > 0 ? k - 1 : -1, i < g.N - 1 ? k + 1 : -1, k - g.N, k + g.N]) {
        if (m < 0 || m >= g.N * g.N || seen[m] || !g.walk[m] || parent[m] !== -2) continue;
        seen[m] = 1; stack.push(m);
      }
    }
    out.push({ n, x: sx / n, z: sz / n, y: sy / n });
  }
  return out.sort((a, b) => b.n - a.n);
}

function pickTargets(g, parent, seed) {
  const cand = [];
  for (let k = 0; k < g.N * g.N; k++) if (g.walk[k] && parent[k] !== -2 && k !== seed) cand.push(k);
  const picks = [];
  const dmin = new Float64Array(cand.length).fill(Infinity);
  let last = seed;
  for (let t = 0; t < TARGETS && cand.length; t++) {
    const [lx, lz] = cellXZ(g, last);
    let bi = -1, bd = -1;
    for (let c = 0; c < cand.length; c++) {
      const [x, z] = cellXZ(g, cand[c]);
      dmin[c] = Math.min(dmin[c], Math.hypot(x - lx, z - lz));
      if (dmin[c] > bd) { bd = dmin[c]; bi = c; }
    }
    last = cand[bi]; picks.push(last);
  }
  return picks;
}

function pathTo(g, parent, target) {
  const chain = [];
  for (let k = target; k >= 0; k = parent[k]) chain.push(k);
  chain.reverse();
  const pts = [];
  for (let n = 0; n < chain.length; n++) {
    const prev = chain[n - 1];
    const bridge = prev !== undefined && Math.abs(chain[n] - prev) !== 1 && Math.abs(chain[n] - prev) !== g.N;
    if (n % WAYPOINT_EVERY === 0 || n === chain.length - 1 || bridge) pts.push(cellXZ(g, chain[n]));
  }
  return pts;
}

const DT = 1 / 30;
const SPEED = PLAYER.MOVE_SPEED ?? 4;
function driveBot(island, start, pts) {
  const phys = new PhysicsSystem();
  const p = makePlayer({ x: start[0], y: getIslandSurfaceY(island, start[0], start[1]) + 0.05, z: start[1] });
  let wp = 0, t = 0, lastProg = 0, lastPos = { x: p.position.x, z: p.position.z };
  let swam = false;
  const jumps = [];
  let jumpCheckT = 0, jumpCheckPos = { x: p.position.x, z: p.position.z };
  const goal = pts[pts.length - 1];
  const budget = 30 + pts.length * WAYPOINT_EVERY * CELL / SPEED * 2;
  while (t < budget) {
    while (wp < pts.length - 1 && Math.hypot(pts[wp][0] - p.position.x, pts[wp][1] - p.position.z) < 0.6) wp++;
    const tx = pts[wp][0] - p.position.x, tz = pts[wp][1] - p.position.z;
    const dl = Math.hypot(tx, tz) || 1;
    p.velocity.x = (tx / dl) * SPEED; p.velocity.z = (tz / dl) * SPEED;
    // The server's input step integrates walk velocity before physics (as in
    // test-cave-walk); PhysicsSystem then seats, slope-blocks and prop-pushes.
    p.position.x += p.velocity.x * DT; p.position.z += p.velocity.z * DT;
    phys.update(DT, t, [], [p], [], [island], []);
    t += DT;
    if (p.state === 'swimming') swam = true;
    if (Math.hypot(goal[0] - p.position.x, goal[1] - p.position.z) < 2.5) return { ok: true, t, swam, jumps };
    // A pirate that walks into a lip she cannot step does what a player does:
    // jump (resolveSlopeBlock lets an airborne body over steep ground). Every
    // such jump is recorded; the bot AI has to make the same call.
    if (t - jumpCheckT > 0.8) {
      const grounded = Math.abs(p.velocity.y) < 0.5; // on terrain OR on dock planks
      if (grounded && Math.hypot(p.position.x - jumpCheckPos.x, p.position.z - jumpCheckPos.z) < 0.4) {
        p.velocity.y = PLAYER.JUMP_FORCE;
        jumps.push([p.position.x, p.position.z]);
      }
      jumpCheckT = t; jumpCheckPos = { x: p.position.x, z: p.position.z };
    }
    if (t - lastProg > 2.5) {
      if (Math.hypot(p.position.x - lastPos.x, p.position.z - lastPos.z) < 0.6) {
        const ax = pts[wp][0] - p.position.x, az = pts[wp][1] - p.position.z, al = Math.hypot(ax, az) || 1;
        const g0 = getIslandSurfaceY(island, p.position.x, p.position.z);
        const g1 = getIslandSurfaceY(island, p.position.x + (ax / al) * 1.05, p.position.z + (az / al) * 1.05);
        const why = [`slope ${((g1 - g0) / 1.05).toFixed(2)}`];
        if (resolvePropCollision({ ...p.position }, PLAYER.RADIUS, island).pushed) why.push('prop');
        if (inTavernWall(island, p.position.x, p.position.y, p.position.z, PLAYER.RADIUS + 0.05)) why.push('tavern');
        return { ok: false, stuck: { x: p.position.x, y: p.position.y, z: p.position.z, why: why.join('+') }, t, swam, jumps };
      }
      lastProg = t; lastPos = { x: p.position.x, z: p.position.z };
    }
  }
  return { ok: false, stuck: { x: p.position.x, y: p.position.y, z: p.position.z, timeout: true }, t, swam, jumps };
}

const t0 = Date.now();
const WAYPOINT_EVERY = 1;
const rows = [];
console.log(`test-bot-island-reach${MUT ? ` [mutate=${MUT}]` : ''}${REPORT ? ' [report]' : ''}`);
for (const island of islands) {
  const name = island.name ?? island.id;
  console.log(`\n── ${name} (${island.id}) ──`);
  const g = buildGraph(island);
  expect(`${name}: grid rim is open sea (the whole island is inside the walk grid)`, g.rimLand === 0, `${g.rimLand} rim cells on land`);
  const sd = seedCells(island, g);
  if (!sd.cells.length) { expect(`${name}: has a landing beach`, false, sd.label); continue; }
  console.log(`  landing: ${sd.label}`);
  const { parent, reached } = flood(island, g, sd.cells);
  const swimRes = flood(island, g, sd.cells, true);
  const footShare = reached / Math.max(1, g.walkable);
  const share = swimRes.reached / Math.max(1, g.walkable);
  console.log(`  on foot only: ${(footShare * 100).toFixed(1)}% of walkable land`);
  const pk = pockets(g, swimRes.parent).filter((q) => q.n >= 20).slice(0, 4)
    .map((q) => `${q.n} m² @(${(q.x - island.position.x).toFixed(0)},${(q.z - island.position.z).toFixed(0)}) y${q.y.toFixed(1)}`);
  expect(`A ${name}: reaches ${(share * 100).toFixed(1)}% of ${g.walkable} m² walkable from the landing beach, wading/swimming allowed (>= ${REACH_MIN * 100}%)`,
    share >= REACH_MIN, pk.length ? `unreached: ${pk.join('; ')}` : '');

  // Part C: the authored detail POIs sit on their landforms and are reachable.
  if (island.id === 'parley-point') {
    const mesa = findRec(island, 'parley-mesa');
    const t = (island.props ?? []).find((p) => p.type === 'parley_table');
    const [tx, tz] = t ? localOf(island, t) : [NaN, NaN];
    const off = Math.hypot(tx - mesa.center[0], tz - mesa.center[1]);
    const ty = t ? getIslandSurfaceY(island, t.x, t.z) : NaN;
    expect(`C ${name}: parley_table stands on the mesa top (inside the cliff ring, at topY)`,
      off <= mesa.radius - 6 && Math.abs(ty - mesa.topY) <= 0.5, `(${tx.toFixed(1)},${tz.toFixed(1)}) ${off.toFixed(1)} m off the mesa centre, y ${ty.toFixed(1)} vs ${mesa.topY}`);
    const near = reachedNear(island, g, swimRes.parent, tx, tz, 5);
    expect(`C ${name}: a pirate walks up to the parley table`, near.hit >= 10, `${near.hit}/${near.n} cells within 5 m reached`);
  }
  if (island.id === 'old-maw-caldera') {
    const crater = findRec(island, 'old-maw-crater');
    const m = (island.props ?? []).find((p) => p.type === 'mine_head');
    const [mx, mz] = m ? localOf(island, m) : [NaN, NaN];
    const d = Math.hypot(mx - crater.center[0], mz - crater.center[1]);
    const my = m ? getIslandSurfaceY(island, m.x, m.z) : NaN;
    const skirt = crater.rimRadius + (crater.outerRun ?? 30);
    expect(`C ${name}: mine head on the cone's outer slope (beyond the rim skirt, well under the rim crest)`,
      d >= skirt && d <= skirt + 20 && my <= crater.rimY - 15, `${d.toFixed(1)} m off the crater centre (skirt ${skirt}), y ${my.toFixed(1)} vs rim ${crater.rimY}`);
    const nearM = reachedNear(island, g, swimRes.parent, mx, mz, 6);
    expect(`C ${name}: a pirate walks up to the mine head`, nearM.hit >= 10, `${nearM.hit}/${nearM.n} cells within 6 m reached`);
    // The rim crest ring (+-2 m of the rim radius) is walked from the beach.
    const rim = reachedNear(island, g, swimRes.parent, crater.center[0], crater.center[1], crater.rimRadius + 2,
      (_k, dist) => dist >= crater.rimRadius - 2);
    expect(`C ${name}: the rim crest is reachable on foot (walk-in rim trail)`, rim.n > 100 && rim.hit / rim.n >= 0.8,
      `${rim.hit}/${rim.n} rim cells reached`);
    const trail = findRec(island, 'old-maw-rim-trail');
    const onTrail = (island.props ?? []).filter((p) => {
      if (!trail || !['watchtower', 'mine_head'].includes(p.type)) return false;
      const [px, pz] = localOf(island, p);
      return trail.path.some(([ax, az]) => Math.hypot(px - ax, pz - az) < trail.topHalfWidth + 5);
    });
    expect(`C ${name}: no landmark pad sits on the rim trail`, onTrail.length === 0, onTrail.map((p) => p.type).join(',') || 'none');
  }

  // Physics runs start where the route starts (the BFS root of each target).
  const targets = pickTargets(g, parent, sd.cells[0]);
  let arrived = 0, swam = false;
  const stuck = [];
  const jumpAt = new Map();
  for (const tk of targets) {
    const pts = pathTo(g, parent, tk);
    const r = driveBot(island, pts[0], pts);
    if (r.ok) arrived++;
    else stuck.push(`(${(r.stuck.x - island.position.x).toFixed(1)},${r.stuck.y.toFixed(1)},${(r.stuck.z - island.position.z).toFixed(1)})${r.stuck.timeout ? ' timeout' : ` ${r.stuck.why}`}`);
    swam ||= r.swam;
    for (const [jx, jz] of r.jumps) jumpAt.set(`${Math.round(jx - island.position.x)},${Math.round(jz - island.position.z)}`, 1);
  }
  if (jumpAt.size) console.log(`  lips that needed a jump: ${[...jumpAt.keys()].slice(0, 8).map((k) => `(${k})`).join(' ')}${jumpAt.size > 8 ? ` +${jumpAt.size - 8}` : ''}`);
  expect(`B ${name}: physics bot arrives at ${arrived}/${targets.length} targets (>= ${ARRIVE_MIN})`,
    arrived >= Math.min(ARRIVE_MIN, targets.length) && targets.length >= ARRIVE_MIN, stuck.length ? `stuck at ${stuck.join(' ')}` : '');
  expect(`B ${name}: never swims on a land route`, !swam);
  rows.push({ id: island.id, share, arrived });
}

console.log(`\n${rows.length}/${islands.length} islands measured in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failures) {
  console.error(`test-bot-island-reach: ${failures} FAIL${REPORT ? ' (report mode, exit 0)' : ''}`);
  process.exit(REPORT ? 0 : 1);
}
console.log('test-bot-island-reach: PASS');
