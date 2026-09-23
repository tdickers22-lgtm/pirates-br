#!/usr/bin/env node
// GANGWAY WALK CONTRACT — a berthed ship's boarding plank must be walkable.
//
// The plank is shared geometry (getShipGangwayPlan / getGangwayFloorY): the
// renderer draws it, PhysicsSystem stands players on it. But the swimmer/hull
// pushout also runs on 'alive' walkers below the deck rail (that's what stops
// walk-through-the-hull at a dock), and the plank's inboard end sits INSIDE the
// hull footprint by construction — it hangs off the cap rail. Without an
// exemption the pushout shoves anyone near the ship end of the plank sideways
// off it and into the sea.
//
// This walks a pirate from the dock deck up the plank, for all three hull
// classes, at every dock in the fixed world, through the REAL PhysicsSystem.
import { Match } from '../src/server/core/Match.ts';
import { PhysicsSystem } from '../src/server/systems/PhysicsSystem.ts';
import { getShipGangwayPlan, toShipLocalPoint, hullBeamHalf } from '../src/shared/interactions.ts';
import { getHullContactChain } from '../src/shared/hull.ts';
import { toDockLocalPoint, dockLocalToWorld } from '../src/shared/utils/index.ts';
import { SHIP_STATS, PLAYER, SHIP } from '../src/shared/constants/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const match = new Match({ matchId: 'gangway-walk', botCount: 0 });
const state = match['state'];
const mapGen = match['mapGen'];
const physics = new PhysicsSystem();
const dockIslands = state.islands.filter((island) => island.dock);

console.log(`Gangway walk (${dockIslands.length} docks × 3 hulls)`);

const results = [];
for (const type of ['sloop', 'brigantine', 'galleon']) {
  for (const island of dockIslands) {
    const dock = island.dock;
    const ship = mapGen.buildShip(`gw-${type}`, 'owner', { position: { x: 0, y: 0, z: 0 }, rotation: 0, type }, 0x3366cc);
    match['parkShipAtDock'](ship, dock);
    ship.anchored = true;
    const plan = getShipGangwayPlan(ship, dock);
    if (!plan) { results.push({ type, island: island.name, plan: false }); continue; }

    // Face the plank and walk it, dock end → ship end, at plain walk speed.
    const dirX = plan.shipEnd.x - plan.dockEnd.x;
    const dirZ = plan.shipEnd.z - plan.dockEnd.z;
    const span = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / span;
    const uz = dirZ / span;

    const player = match['createPlayer']('gw-walker', 'Walker', null, false);
    player.position = { x: plan.dockEnd.x - ux * 1.0, y: plan.dockEnd.y + 0.15, z: plan.dockEnd.z - uz * 1.0 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.state = 'alive';
    player.onShipId = null;

    const dt = 1 / 30;
    let t = 0;
    let swam = false;
    let worstOffAxis = 0;
    let boarded = false;
    const deckY = ship.position.y + SHIP_STATS[type].height;
    for (let step = 0; step < 240; step++) {
      // Match.applyInput's walk step, then the server physics resolve.
      player.velocity.x = ux * PLAYER.MOVE_SPEED;
      player.velocity.z = uz * PLAYER.MOVE_SPEED;
      player.position.x += player.velocity.x * dt;
      player.position.z += player.velocity.z * dt;
      physics.update(dt, t, [ship], [player], [], state.islands, state.seaRocks ?? [], null);
      t += dt;
      if (player.state === 'swimming') swam = true;
      const rx = player.position.x - plan.dockEnd.x;
      const rz = player.position.z - plan.dockEnd.z;
      const along = rx * ux + rz * uz;
      if (along > -0.2 && along < span + 0.4) worstOffAxis = Math.max(worstOffAxis, Math.abs(rx * uz - rz * ux));
      if (player.onShipId === ship.id && player.position.y > deckY - 0.6) {
        boarded = true;
        break;
      }
    }
    results.push({ type, island: island.name, plan: true, boarded, swam, worstOffAxis, span });
  }
}

const planked = results.filter((r) => r.plan);
expect('every dock offers a boarding plank for every hull class', planked.length === results.length,
  results.filter((r) => !r.plan).map((r) => `${r.type} @ ${r.island}`).join(', '));

const dunked = planked.filter((r) => r.swam);
expect('walking the plank never dunks the pirate', dunked.length === 0,
  dunked.map((r) => `${r.type} @ ${r.island}`).join('\n     '));

const shoved = planked.filter((r) => r.worstOffAxis > 0.9);
expect('the hull pushout never shoves a plank walker sideways off it', shoved.length === 0,
  shoved.map((r) => `${r.type} @ ${r.island}: offAxis=${r.worstOffAxis.toFixed(2)}m`).join('\n     '));

const stranded = planked.filter((r) => !r.boarded);
expect('the walk reaches the deck on every plank', stranded.length === 0,
  stranded.map((r) => `${r.type} @ ${r.island}: offAxis=${r.worstOffAxis.toFixed(2)} span=${r.span.toFixed(2)}`).join('\n     '));

console.log(`     planks=${planked.length} worstOffAxis=${Math.max(...planked.map((r) => r.worstOffAxis)).toFixed(2)}m`);

// Spawn berths sit well inside the phase-1 ring (liveplay-09): a new crew that
// drifts or swims a little during the truce must not be outside the circle.
{
  const ring = match['storm'].getFirstRingRadius();
  let worst = null;
  for (const island of dockIslands) {
    for (const p of [island.dock.berthPosition, island.dock.respawnPoint]) {
      const inside = ring - Math.hypot(p.x, p.z);
      if (!worst || inside < worst.inside) worst = { inside, island: island.name };
    }
  }
  expect('every spawn berth and pier respawn is >= 60 m inside the phase-1 ring', worst && worst.inside >= 60,
    worst ? `${worst.island}: ${worst.inside.toFixed(1)} m inside a ${ring.toFixed(0)} m ring` : 'no docks');
  console.log(`     ring=${ring.toFixed(0)}m tightest berth ${worst?.inside.toFixed(1)}m inside (${worst?.island})`);
}

// FROM THE SPAWN POINT (liveplay-09): createCrew lands each member on the pier
// (respawnPoint + the BERTH_LANDING_SPREAD offset, a stride apart) beside the
// hull it just parked. Two first-20-seconds walks must board her dry:
//   ROUTE  — along the pier to the plank's foot, then up the plank;
//   NAIVE  — straight at the hull's centre, the way a newcomer does it.
// And the open water between the pier edge and her widest planking must be a
// step, not a swim: < 0.4 m, yet clear of the pier box (the ship-vs-dock
// pushout's own contact chain) by more than a 3 deg roll swings the wale.
{
  const fakeWs = () => ({ readyState: 1, bufferedAmount: 0, send() {}, close() {} });
  const spawnMatch = new Match({ matchId: 'gangway-spawn', botCount: 0 });
  const sState = spawnMatch['state'];
  const walks = [];
  const gaps = [];
  for (let c = 0; c < 16; c++) {
    const size = (c % 4) + 1;
    const { shipId } = spawnMatch.createCrew(Array.from({ length: size }, (_, i) => ({ ws: fakeWs(), name: `S${c}-${i}` })));
    const ship = sState.ships.find((s) => s.id === shipId);
    const crew = sState.players.filter((p) => p.shipId === shipId);
    if (crew.some((p) => p.onShipId === shipId)) continue; // no berth left: rides at anchor
    const island = sState.islands.find((i) => i.dock && Math.hypot(i.dock.position.x - ship.position.x, i.dock.position.z - ship.position.z) < 80);
    const dock = island?.dock;
    const plan = dock ? getShipGangwayPlan(ship, dock) : null;
    if (!plan) { walks.push({ ship: ship.type, island: island?.name, mode: 'plan', ok: false, why: 'no plank' }); continue; }
    gaps.push({ island: island.name, type: ship.type, ship, dock });
    const spawns = crew.map((p) => ({ ...p.position }));
    for (const mode of ['route', 'naive']) {
      for (const [i, member] of crew.entries()) {
        for (const other of crew) { other.onShipId = null; other.state = 'alive'; }
        member.position = { ...spawns[i] };
        member.velocity = { x: 0, y: 0, z: 0 };
        const physics = new PhysicsSystem();
        const waypoints = mode === 'route'
          ? [plan.dockEnd, plan.shipEnd, {
            // then step down off the rail onto the deck, 1.5 m further inboard
            x: plan.shipEnd.x + (plan.shipEnd.x - plan.dockEnd.x) / Math.hypot(plan.shipEnd.x - plan.dockEnd.x, plan.shipEnd.z - plan.dockEnd.z) * 1.5,
            z: plan.shipEnd.z + (plan.shipEnd.z - plan.dockEnd.z) / Math.hypot(plan.shipEnd.x - plan.dockEnd.x, plan.shipEnd.z - plan.dockEnd.z) * 1.5,
          }]
          : [{ x: ship.position.x, z: ship.position.z }];
        let wp = 0, swam = false, boarded = false, t = 0;
        const dt = 1 / 30;
        for (let step = 0; step < 30 * 20 && !boarded; step++) {
          const target = waypoints[Math.min(wp, waypoints.length - 1)];
          const dx = target.x - member.position.x, dz = target.z - member.position.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.3 && wp < waypoints.length - 1) wp += 1;
          const ux = d > 1e-3 ? dx / d : 0, uz = d > 1e-3 ? dz / d : 0;
          member.velocity.x = ux * PLAYER.MOVE_SPEED;
          member.velocity.z = uz * PLAYER.MOVE_SPEED;
          member.position.x += member.velocity.x * dt;
          member.position.z += member.velocity.z * dt;
          physics.update(dt, t, sState.ships, [member], [], sState.islands, sState.seaRocks ?? [], null);
          t += dt;
          if (member.state === 'swimming') { swam = true; break; }
          if (member.onShipId === ship.id) boarded = true;
        }
        walks.push({ ship: ship.type, island: island.name, mode, member: i, ok: boarded && !swam, swam, boarded,
          at: `${member.position.x.toFixed(1)},${member.position.y.toFixed(2)},${member.position.z.toFixed(1)}` });
      }
    }
  }
  const berthed = new Set(walks.map((w) => `${w.island}/${w.ship}`)).size;
  expect('createCrew berthed crews at docks to walk from', berthed >= 4, `berthed=${berthed}`);
  const bad = walks.filter((w) => (w.mode === 'route' || w.mode === 'plan') && !w.ok);
  expect(`walk from the spawn point via the plank boards the hull without swimming (${walks.filter((w) => w.mode === 'route').length} walks)`,
    bad.length === 0, bad.map((w) => `${w.ship} @ ${w.island} member ${w.member}: ${w.why ?? (w.swam ? 'SWAM' : 'stranded')} at ${w.at}`).join('\n     '));
  const naive = walks.filter((w) => w.mode === 'naive');
  const naiveBad = naive.filter((w) => !w.ok);
  expect(`a newcomer walking straight at his hull's centre from where he lands boards her dry (${naive.length} walks)`,
    naive.length > 0 && naiveBad.length === 0,
    naiveBad.map((w) => `${w.ship} @ ${w.island} member ${w.member}: ${w.swam ? 'SWAM' : 'stranded'} at ${w.at}`).join('\n     '));
  // Measured AFTER the walks ran PhysicsSystem over every hull for up to 20 s:
  // a berth the pier pushout shoves (the old galleon, 0.16 m inside the box)
  // shows up here as a drifted gap.
  const berthGaps = gaps.map(({ island, type, ship, dock }) => {
    const stats = SHIP_STATS[type];
    const inDock = toDockLocalPoint(dock, ship.position.x, ship.position.z);
    const skin = Math.abs(inDock.x) - dock.width * 0.5 - hullBeamHalf(type);
    let chainClear = Infinity;
    for (const st of getHullContactChain(type)) {
      const zl = st.zF * stats.length;
      const p = toDockLocalPoint(dock, ship.position.x + zl * Math.sin(ship.rotation), ship.position.z + zl * Math.cos(ship.rotation));
      chainClear = Math.min(chainClear, Math.abs(p.x) - dock.width * 0.5 - stats.width * st.halfF);
    }
    const rollSwing = Math.sin(3 * Math.PI / 180) * stats.height * (1 - SHIP.HULL_DRAFT_F[type]);
    return { island, type, skin, chainClear, rollSwing };
  });
  const wide = berthGaps.filter((g) => !(g.skin < 0.4));
  expect(`pier edge to the hull's widest planking is < 0.4 m at every spawn berth (${berthGaps.length})`, berthGaps.length > 0 && wide.length === 0,
    wide.map((g) => `${g.type} @ ${g.island}: ${g.skin.toFixed(2)} m`).join('\n     '));
  const rub = berthGaps.filter((g) => !(g.chainClear > g.rollSwing));
  expect('no berthed hull touches the pier, even rolled 3 deg', rub.length === 0,
    rub.map((g) => `${g.type} @ ${g.island}: clear ${g.chainClear.toFixed(2)} m, roll swing ${g.rollSwing.toFixed(2)} m`).join('\n     '));
  const worstGap = berthGaps.reduce((a, g) => (!a || g.skin > a.skin ? g : a), null);
  const tightest = berthGaps.reduce((a, g) => (!a || g.chainClear - g.rollSwing < a.chainClear - a.rollSwing ? g : a), null);
  console.log(`     spawn walks=${walks.length} berths=${berthed} naive dry ${naive.length - naiveBad.length}/${naive.length}; `
    + `widest pier-to-planking gap ${worstGap?.skin.toFixed(2)} m (${worstGap?.type} @ ${worstGap?.island}); `
    + `tightest pier clearance ${tightest?.chainClear.toFixed(2)} m vs roll swing ${tightest?.rollSwing.toFixed(2)} m (${tightest?.type})`);
}

if (failures > 0) {
  console.error(`\n${failures} gangway-walk assertion(s) failed.`);
  process.exit(1);
}
console.log('\nUp the plank and over the rail, on every hull.');
