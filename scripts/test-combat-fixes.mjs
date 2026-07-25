#!/usr/bin/env node
// Combat audit fixes (.audit/combat.md + storm finding 6), end-to-end against
// the real modules via tsx:
//   1. waterline shots hole hulls (ship test runs BEFORE the water kill)
//   2. chainshot connects through the mast/rigging band above the hull (and
//      never holes hulls)
//   3. ram-sinks credit the attacking ship's crew (kill + gold banked)
//   4. floodingRate is the NET bilge trend — negative while bailers are winning
//   5. cannonball ammo selection falls back to firebomb/chainshot when empty
//   6. bots bail under player-like constraints (aboard, off-station, capped)
//   7. storm damage stoves REAL breaches into the seaward face → holes + flooding
//   8. ship_damage broadcasts reach every client, not just the attacker
//   9. keg blasts cluster breaches on the face the barrel was lashed to
//  10. a saturated hull is never immune — the cap re-opens a patched breach
//  11. the hole list fits the wire budget even with every hull at the cap
import { PhysicsSystem, updateShipFlooding, evaluateHoleFlood } from '../src/server/systems/PhysicsSystem.ts';
import { WeaponSystem } from '../src/server/systems/WeaponSystem.ts';
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS, FLOODING, PLAYER } from '../src/shared/constants/index.ts';
import { gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';
import { countOpenHoles, toShipLocalPoint } from '../src/shared/interactions.ts';
import { buildHotSnapshot, buildWireSnapshot } from '../src/server/core/snapshot.ts';

/** Which hull face a hull-local breach point lies on. Beam-normalised: a hull
 *  is far longer than it is wide, so a point at the half-beam 3.6 m aft is on
 *  the STARBOARD side, not the stern. */
function holeFace(hole, stats) {
  const bx = Math.abs(hole.x) / (stats.width * 0.5);
  const bz = Math.abs(hole.z) / (stats.length * 0.5);
  return bz >= bx
    ? (hole.z >= 0 ? 'bow' : 'stern')
    : (hole.x >= 0 ? 'starboard' : 'port');
}

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const DT = 1 / 60;

function makeShip(type = 'sloop', overrides = {}) {
  const stats = SHIP_STATS[type];
  return {
    id: `ship-${Math.random().toString(36).slice(2, 8)}`,
    type,
    ownerId: 'owner',
    crewIds: [],
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: 0,
    sailHeight: 0,
    sailAngle: 0,
    anchored: false,
    anchorRaiseProgress: 0,
    holes: [],
    nextHoleId: 1,
    maxHull: stats.maxHull,
    onFire: false,
    fireTimer: 0,
    fireDamageAccum: 0,
    sinkProgress: 0,
    sinking: false,
    cannonCooldowns: Array(stats.cannonCount).fill(0),
    chainshottedUntil: 0,
    sailIntegrity: 1,
    sailRepairWoodTimer: 0,
    gold: 0,
    treasureChestIds: [],
    inventory: [],
    repairCooldown: 0,
    autoRepairProgress: 0,
    teamColor: 0x3366cc,
    alive: true,
    upgrades: [],
    pitch: 0,
    roll: 0,
    heave: 0,
    waterLevel: 0,
    ...overrides,
  };
}

function makeProjectile(overrides = {}) {
  return {
    id: `proj-${Math.random().toString(36).slice(2, 8)}`,
    type: 'cannonball',
    ownerId: 'attacker',
    ownerShipId: 'attacker-ship',
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    alive: true,
    age: 0,
    maxAge: 8,
    damage: SHIP.CANNON_DAMAGE_HULL,
    knockback: 0,
    visualOnly: false,
    showImpact: true,
    ...overrides,
  };
}

/** First grid point in open water: clear of every island footprint and sea
 *  rock, inside the world margin, and passing the caller's predicate. */
function findOpenSea(state, accept = () => true) {
  for (let x = -850; x <= 850; x += 25) {
    for (let z = -850; z <= 850; z += 25) {
      if (!accept(x, z)) continue;
      let clear = true;
      for (const island of state.islands) {
        const spread = Math.max(island.profile?.footprintX ?? 1, island.profile?.footprintZ ?? 1);
        const d = Math.hypot(x - island.position.x, z - island.position.z);
        if (d < island.radius * spread + 90) { clear = false; break; }
      }
      if (!clear) continue;
      for (const rock of state.seaRocks) {
        const d = Math.hypot(x - rock.position.x, z - rock.position.z);
        if (d < (rock.colliderBoundsRadius ?? rock.radius) + 50) { clear = false; break; }
      }
      if (clear) return { x, z };
    }
  }
  throw new Error('no open-sea point found for test setup');
}

function makeFakeWs(sink = null) {
  return {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send(data) { if (sink) sink.push(JSON.parse(data)); },
    close() {},
  };
}

function makeBailInput(seq = 1) {
  return {
    seq, ts: 0,
    forward: false, back: false, left: false, right: false,
    jump: false, jumpPressed: false, fire: false, aim: false,
    interact: true, interactHeld: true,
    anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
    trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
    slot: null, cannonAmmo: null, yaw: 0, pitch: 0,
    wheelIndex: null, useWheelItem: false, barrelTakeAll: false,
    interactIntent: 'bail',
  };
}

// ────────────────────────────────────────────────────────────────────────────
console.log('1. Waterline shots hole hulls (ship test beats the water kill)');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop', {
    position: { x: 0, y: gerstnerHeight(0, 0, 0, WAVE_PARAMS), z: 0 },
  });
  // A ball already dipping just below the local wave surface but inside the
  // hull volume — the classic aim-at-the-waterline shot the flooding model
  // rewards. The old order killed it as a splash before the ship test ran.
  const surfaceY = gerstnerHeight(0.5, 0, 0, WAVE_PARAMS);
  const proj = makeProjectile({
    position: { x: 0.5, y: surfaceY - 0.35, z: 0 },
    velocity: { x: 0, y: -2, z: 0 },
  });
  physics.update(DT, 0, [ship], [], [proj], [], [], null);

  expect('below-surface ball inside the hull registers the hit', proj.alive === false);
  expect('the waterline shot opens exactly ONE breach', ship.holes.length === 1,
    JSON.stringify(ship.holes));
  const breach = ship.holes[0];
  expect('the breach is on the struck (starboard) face', holeFace(breach, SHIP_STATS.sloop) === 'starboard',
    `${holeFace(breach, SHIP_STATS.sloop)} at (${breach.x.toFixed(2)}, ${breach.z.toFixed(2)})`);
  // The whole point of the rewrite: the hole is AT the ball, not at a canonical
  // section decal point.
  const wantLocal = toShipLocalPoint({ x: 0.5, z: 0 }, ship);
  expect('the breach lands within 10 cm of the impact point',
    Math.hypot(breach.x - wantLocal.x, breach.z - wantLocal.z) < 0.1,
    `want (${wantLocal.x.toFixed(2)}, ${wantLocal.z.toFixed(2)}) got (${breach.x.toFixed(2)}, ${breach.z.toFixed(2)})`);
  // Height comes from the ball too: this one struck BELOW the design waterline,
  // so the breach sits below y=0 — not snapped to a canonical decal band.
  expect('the breach height is the ball\'s height, below the waterline',
    breach.y < -0.2 && breach.y > -0.6, `y=${breach.y.toFixed(3)}`);
  const events = physics.flushCombatEvents();
  const hit = events.find((e) => e.type === 'ship_hit');
  expect('ship_hit event emitted for the waterline shot',
    !!hit && hit.targetId === ship.id && hit.section === 'starboard',
    JSON.stringify(events));
  expect('ship_hit carries the hull-local breach so clients decal it instantly',
    !!hit && hit.holes.length === 1 && hit.holes[0].id === breach.id,
    JSON.stringify(hit?.holes));

  // Control: the water kill still applies when no hull occupies the splash.
  const splash = makeProjectile({
    position: { x: 0.5, y: surfaceY - 0.35, z: 0 },
    velocity: { x: 0, y: -2, z: 0 },
  });
  physics.update(DT, 0, [], [], [splash], [], [], null);
  expect('open-water shots still die on the surface', splash.alive === false);
  expect('...without any combat event', physics.flushCombatEvents().length === 0);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n2. Chainshot shreds rigging ABOVE the hull band; never holes hulls');

{
  const physics = new PhysicsSystem();
  const stats = SHIP_STATS.sloop;
  const ship = makeShip('sloop', {
    position: { x: 0, y: gerstnerHeight(0, 0, 0, WAVE_PARAMS), z: 0 },
    sailHeight: 1,
  });
  // Well above the hull hit band (height + 1.1) but through the canvas.
  const riggingY = ship.position.y + stats.height + 2.0;
  const chain = makeProjectile({
    type: 'chainshot',
    position: { x: 0.5, y: riggingY, z: 1 },
  });
  physics.update(DT, 2, [ship], [], [chain], [], [], null);

  expect('chainshot through the mast band connects above the hull', chain.alive === false);
  expect('chainshot fouls the helm (chainshottedUntil = t + 30)',
    ship.chainshottedUntil === 32, `chainshottedUntil=${ship.chainshottedUntil}`);
  expect('chainshot tears the canvas', ship.sailIntegrity < 1 && ship.sailHeight < 1,
    `integrity=${ship.sailIntegrity} height=${ship.sailHeight}`);
  expect('chainshot opens NO hull breaches', ship.holes.length === 0, JSON.stringify(ship.holes));
  const chainHit = physics.flushCombatEvents().find((e) => e.type === 'ship_hit');
  expect('rigging hit reports 0 hull damage', !!chainHit && chainHit.damage === 0,
    `damage=${chainHit?.damage}`);

  // Control: a cannonball at the same height sails clean through the rigging.
  const ship2 = makeShip('sloop', {
    position: { x: 0, y: gerstnerHeight(0, 0, 0, WAVE_PARAMS), z: 0 },
  });
  const ball = makeProjectile({ position: { x: 0.5, y: riggingY, z: 1 } });
  physics.update(DT, 2, [ship2], [], [ball], [], [], null);
  expect('a cannonball at mast height passes over the hull band', ball.alive === true);
  expect('...leaving the planking untouched', ship2.holes.length === 0);
  physics.flushCombatEvents();
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n3. Ramming a ship to death credits the attacking crew');

{
  const match = new Match({ matchId: 'combat-ram', botCount: 3 });
  const st = match.state;
  st.phase = 'playing';
  const attacker = st.players[0];
  const shipA = st.ships.find((s) => s.id === attacker.shipId);
  const shipB = st.ships.find((s) => s.id !== shipA.id);
  const victimCrew = st.players.filter((p) => p.shipId === shipB.id);
  expect('victim ship has crew aboard', victimCrew.length > 0);

  // Side-by-side overlap with hard closing speed — a ram, resolved by the real
  // pairwise hull collision inside physics.update (which also builds the
  // helmsman map from atHelm players). Lateral sections are pre-weakened low
  // enough that the slam zeroes one on ANY victim class (galleon worst case:
  // ~7.6 m/s × 12 × 1.9 T-bone ≈ 0.12 of maxHull).
  shipB.position = { x: 0, y: 0, z: 0 };
  shipB.rotation = 0;
  shipB.velocity = { x: 0, y: 0, z: 0 };
  shipB.anchored = false;
  // Pre-holed along both rails so the slam pushes her over the edge.
  shipB.holes = [];
  shipB.nextHoleId = 1;
  match.physics.openHoleAt(shipB, { x: SHIP_STATS[shipB.type].width * 0.5, y: 0.2, z: 0 }, 2, 'cannon');
  match.physics.openHoleAt(shipB, { x: -SHIP_STATS[shipB.type].width * 0.5, y: 0.2, z: 0 }, 2, 'cannon');
  const holesBeforeRam = shipB.holes.length;
  shipA.position = { x: -3, y: 0, z: 0 };
  shipA.rotation = 0;
  shipA.velocity = { x: 8, y: 0, z: 0 };
  shipA.anchored = false;
  attacker.state = 'alive';
  attacker.atHelm = true;
  attacker.onShipId = shipA.id;
  attacker.position = {
    x: shipA.position.x,
    y: shipA.position.y + SHIP_STATS[shipA.type].height + 0.3,
    z: shipA.position.z,
  };

  match.physics.update(DT, match.t, [shipA, shipB], [attacker], [], [], [], null);
  match.relayPendingCombatEvents();

  const credit = match.shipLastDamagedByPlayer.get(shipB.id);
  expect('ram damage banks sink credit for the rammer\'s helmsman',
    !!credit && credit.attackerId === attacker.id, JSON.stringify(credit ?? null));
  expect('the ram itself stove fresh planking in',
    countOpenHoles(shipB) > holesBeforeRam,
    `before=${holesBeforeRam} after=${countOpenHoles(shipB)}`);
  const ramBreaches = shipB.holes.slice(holesBeforeRam);
  const bStats = SHIP_STATS[shipB.type];
  expect('the ram breach lands on the beam the rammer actually struck',
    ramBreaches.length > 0 && ramBreaches.every((h) => holeFace(h, bStats) === 'port'),
    JSON.stringify(ramBreaches.map((h) => [holeFace(h, bStats), +h.x.toFixed(2), +h.z.toFixed(2)])));

  const killsBefore = attacker.kills;
  const goldBefore = attacker.gold;
  // Holes, not hp, decide: the ram breached the hull, so the water finishes
  // the job — run the flood forward to the founder (well under a minute for
  // a wrecked section set) and then assert the credited sink. Sit the wreck
  // low so its ram holes are cleanly below the waterline for the flood.
  shipB.position.y = -1.2;
  shipB.pitch = 0;
  shipB.roll = 0;
  let ramFloodT = 0;
  for (let i = 0; i < 90 * 62 && shipB.sinking !== true; i++) {
    updateShipFlooding(shipB, match.t, DT);
    match.evaluateShipSinking(shipB);
    ramFloodT += DT;
  }
  expect('the rammed ship sinks (via the water pouring through the ram breach)',
    shipB.sinking === true, `flooded ${ramFloodT.toFixed(1)}s`);
  // Sinking a ship does NOT eliminate its crew — they swim out and stay in
  // the fight (their respawn anchor is gone, nothing else). The rammer is
  // paid in a ship-sink bounty, not kill credit.
  expect('the rammed crew survives the sink (swimming, not eliminated)',
    victimCrew.every((p) => p.state === 'swimming' && p.health > 0),
    victimCrew.map((p) => p.state).join(','));
  expect('rammer banks NO kills for the sink itself', attacker.kills === killsBefore,
    `kills=${attacker.kills}`);
  expect('rammer banks the ship-sink bounty', attacker.gold >= goldBefore + PLAYER.SHIP_SINK_GOLD,
    `gold=${attacker.gold} (was ${goldBefore})`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n4. floodingRate is the NET trend — negative while a bailer is winning');

{
  const match = new Match({ matchId: 'combat-net-trend', botCount: 1 });
  const st = match.state;
  const joined = match.addHumanClient(makeFakeWs(), 'Bailer');
  st.phase = 'playing';
  const player = st.players.find((p) => p.id === joined.playerId);
  const ship = st.ships.find((s) => s.id === joined.shipId);
  const bot = st.players.find((p) => p.isBot);
  player.equippedTool = 'bucket'; // physical bailing requires the bucket equipped

  // Park in open water inside a pinned storm ring, one holed section, no
  // auto-repair planks — one bailer (0.014/s) beats one hole (0.010/s).
  const spot = findOpenSea(st, (x, z) => Math.hypot(x, z) < 700);
  ship.position = { x: spot.x, y: 0, z: spot.z };
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.anchored = true;
  ship.inventory = ship.inventory.filter((s) => s.item !== 'wood_plank');
  ship.holes = [];
  ship.nextHoleId = 1;
  match.physics.openHoleAt(ship, { x: -SHIP_STATS[ship.type].width * 0.5, y: 0.05, z: 0 }, 1, 'cannon');
  player.state = 'alive';
  player.onShipId = ship.id;
  player.position = {
    x: spot.x,
    y: ship.position.y + SHIP_STATS[ship.type].height + 0.3,
    z: spot.z,
  };
  st.storm.centerX = 0;
  st.storm.centerZ = 0;
  st.storm.safeRadius = 950;
  st.storm.shrinking = false;
  st.storm.shrinkTimer = 99999;

  // Settle onto the flooded waterline (bilge pinned so the ride height and the
  // submerged-hole test are stable before we measure trends).
  for (let i = 0; i < 240; i++) {
    ship.waterLevel = 0.5;
    player.health = 100;
    if (bot) bot.health = 100;
    match.tick();
  }

  // Control: nobody bailing — the gauge trend must read RISING (+ingress).
  // Sample the published rate across the window rather than one tick: the hull
  // is riding a live Gerstner sea, so the breach's depth (and therefore its
  // instantaneous rate) breathes with the swell. The TREND is the claim.
  const levelBeforeControl = ship.waterLevel;
  let rateSum = 0;
  let risingTicks = 0;
  for (let i = 0; i < 30; i++) {
    player.health = 100; if (bot) bot.health = 100;
    match.tick();
    rateSum += ship.floodingRate;
    if (ship.floodingRate > 0) risingTicks += 1;
  }
  expect('untended hole: replicated floodingRate reads RISING across the window',
    rateSum / 30 > 0.005, `meanRate=${(rateSum / 30).toFixed(5)}`);
  expect('untended hole: the gauge arrow points up on nearly every tick',
    risingTicks >= 27, `${risingTicks}/30 ticks rising`);
  expect('untended hole: water actually rises', ship.waterLevel > levelBeforeControl + 0.0015,
    `water ${levelBeforeControl.toFixed(4)} → ${ship.waterLevel.toFixed(4)}`);

  // One bailer via the real input path — the SCOOP → HEAVE cycle. Pressing
  // interact each tick (fresh seq) fires an action whenever the scoop/heave lock
  // clears, so a diligent bailer's net rate beats one open hole and the standing
  // water falls even though the hole stays open.
  const client = match.clients.get(joined.playerId);
  const levelBeforeBail = ship.waterLevel;
  let bailSeq = 1000;
  let sawFilledBucket = false;
  let sawBailing = false;
  for (let i = 0; i < 300; i++) {
    player.health = 100; if (bot) bot.health = 100;
    client.lastInput = makeBailInput(bailSeq++);
    match.tick();
    if (player.bucketFilled) sawFilledBucket = true;
    if (player.bailing) sawBailing = true;
  }
  expect('bailer scoops (bucket fills during the cycle)', sawFilledBucket === true);
  expect('bailer is recognized (player.bailing set during a scoop/heave)', sawBailing === true);
  expect('cycling bailer: water actually falls', ship.waterLevel < levelBeforeBail - 0.01,
    `water ${levelBeforeBail.toFixed(4)} → ${ship.waterLevel.toFixed(4)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n5. Cannonball selection falls back like firebomb/chainshot');

{
  const weapons = new WeaponSystem();
  const gunner = {
    id: 'gunner', state: 'alive', atCannon: true,
    selectedCannonAmmo: 'cannonball', superCannonballs: 0,
  };
  const fire = (ship) => {
    weapons.tryFire(gunner, ship, 0, 0, 0);
    return weapons.flushProjectiles()[0] ?? null;
  };

  // Empty ball rack + firebombs in the hold → fires a firebomb.
  const shipFb = makeShip('sloop', { inventory: [{ item: 'firebomb_ball', qty: 2 }] });
  const fb = fire(shipFb);
  expect('no cannonballs → falls back to firebomb', !!fb && fb.type === 'firebomb',
    `type=${fb?.type}`);
  expect('firebomb fallback consumes the stock', shipFb.inventory[0].qty === 1,
    JSON.stringify(shipFb.inventory));

  // Only chainshot left → fires chainshot.
  const shipCs = makeShip('sloop', { inventory: [{ item: 'chainshot', qty: 1 }] });
  const cs = fire(shipCs);
  expect('no cannonballs/firebombs → falls back to chainshot', !!cs && cs.type === 'chainshot',
    `type=${cs?.type}`);

  // Banked super shot keeps its cannonball-only gate (no inventory needed).
  const shipSuper = makeShip('sloop');
  gunner.superCannonballs = 1;
  const superShot = fire(shipSuper);
  expect('empty hold + banked super → super cannonball fires',
    !!superShot && superShot.type === 'cannonball' && superShot.special === 'super_cannonball',
    `type=${superShot?.type} special=${superShot?.special}`);
  expect('super shot consumed', gunner.superCannonballs === 0);

  // Truly empty → the cannon stays silent (and doesn't burn its reload).
  const shipEmpty = makeShip('sloop');
  const dud = fire(shipEmpty);
  expect('empty hold, no supers → no shot', dud === null);
  expect('a refused shot does not start the reload', shipEmpty.cannonCooldowns[0] === 0,
    `cooldown=${shipEmpty.cannonCooldowns[0]}`);

  // Regression: the other preferences still fall back to cannonball.
  gunner.selectedCannonAmmo = 'chainshot';
  const shipBalls = makeShip('sloop', { inventory: [{ item: 'cannonball', qty: 3 }] });
  const ball = fire(shipBalls);
  expect('chainshot preference still falls back to cannonball', !!ball && ball.type === 'cannonball',
    `type=${ball?.type}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n6. Bots bail under player-like constraints');

{
  const match = new Match({ matchId: 'combat-bot-bail', botCount: 3 });
  const st = match.state;
  const bots = st.players.filter((p) => p.isBot);
  const [b0, b1, b2] = bots;
  const ship = st.ships.find((s) => s.id === b0.shipId);
  for (const b of bots) { b.atHelm = false; b.atCannon = false; b.atSails = false; b.atCrowNest = false; }

  // No breaches for the bailing sub-tests: with an open hole a bot abandons the
  // bucket to walk to it (patch-before-bail priority), which is its own test below.
  ship.holes = [];
  ship.nextHoleId = 1;

  // Not aboard → no bailing (the old code let any bot bail from anywhere).
  ship.waterLevel = 0.6;
  b0.onShipId = null;
  match.updateBotFlooding(DT);
  expect('a bot NOT aboard its ship cannot bail',
    ship.waterLevel === 0.6 && b0.bailing === false, `water=${ship.waterLevel}`);

  // Manning a station → hands are full, no bailing (same rule as humans).
  b0.onShipId = ship.id;
  b0.atHelm = true;
  match.updateBotFlooding(DT);
  expect('a bot at the helm cannot bail',
    ship.waterLevel === 0.6 && b0.bailing === false, `water=${ship.waterLevel}`);

  // Shallow bilge → bots don't busy-bail below the threshold.
  b0.atHelm = false;
  ship.waterLevel = FLOODING.BOT_BAIL_THRESHOLD - 0.1;
  match.updateBotFlooding(DT);
  expect('below the bail threshold the bot keeps working',
    ship.waterLevel === FLOODING.BOT_BAIL_THRESHOLD - 0.1 && b0.bailing === false);

  // Aboard, free, deep water → bails at exactly one bucket rate.
  ship.waterLevel = 0.6;
  match.updateBotFlooding(DT);
  expect('an aboard, off-station bot bails deep water',
    b0.bailing === true && Math.abs(ship.waterLevel - (0.6 - FLOODING.BAIL_RATE * DT)) < 1e-9,
    `water=${ship.waterLevel}`);

  // Bucket line caps at two per hull — a full crew can't stack free drain.
  for (const b of [b1, b2]) {
    b.shipId = ship.id;
    b.onShipId = ship.id;
    b.bailing = false;
  }
  ship.waterLevel = 0.6;
  match.updateBotFlooding(DT);
  const bailers = bots.filter((b) => b.bailing).length;
  expect('at most two bots bail one hull', bailers === 2, `bailers=${bailers}`);
  expect('drain equals exactly two buckets',
    Math.abs(ship.waterLevel - (0.6 - 2 * FLOODING.BAIL_RATE * DT)) < 1e-9,
    `water=${ship.waterLevel}`);

  // Per-hole damage control: a bot abandons the bucket, walks to the rail above
  // ONE specific breach, and planks THAT id.
  for (const b of bots) { b.bailing = false; b.onShipId = ship.id; b.shipId = ship.id; }
  ship.holes = [];
  ship.nextHoleId = 1;
  ship.waterLevel = 0.6;
  ship.inventory = [...ship.inventory.filter((e) => e.item !== 'wood_plank'), { item: 'wood_plank', qty: 6 }];
  const stats6 = SHIP_STATS[ship.type];
  match.physics.openHoleAt(ship, { x: stats6.width * 0.5, y: 0.2, z: stats6.length * 0.3 }, 1, 'cannon');
  const target = ship.holes[0];
  // Park the crew amidships, nowhere near the breach.
  for (const b of bots) {
    b.position = { x: ship.position.x, y: ship.position.y + stats6.height + 0.3, z: ship.position.z };
  }
  const startDist = Math.hypot(
    toShipLocalPoint(b0.position, ship).x - target.x,
    toShipLocalPoint(b0.position, ship).z - target.z,
  );
  let patched = false;
  for (let i = 0; i < 900 && !patched; i++) {
    match.updateBotFlooding(DT);
    patched = ship.holes[0].patched === true;
  }
  const endLocal = toShipLocalPoint(b0.position, ship);
  expect('a bot walks to the rail above the breach', 
    Math.hypot(endLocal.x - target.x, endLocal.z - target.z) < startDist,
    `start=${startDist.toFixed(2)}m end=${Math.hypot(endLocal.x - target.x, endLocal.z - target.z).toFixed(2)}m`);
  expect('...and planks THAT specific breach id', patched === true,
    JSON.stringify(ship.holes));
  expect('planking it consumed a plank',
    (ship.inventory.find((e) => e.item === 'wood_plank')?.qty ?? 0) < 6);
  expect('the patched breach stops leaking', evaluateHoleFlood(ship, 0).length === 0);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n7. Storm damage punches holes (damageHullSection) instead of melting');

{
  const match = new Match({ matchId: 'combat-storm-holes', botCount: 2 });
  const st = match.state;
  st.phase = 'playing';
  const [b0, b1] = st.players.filter((p) => p.isBot);
  const testShip = st.ships.find((s) => s.id === b0.shipId);
  const safeShip = st.ships.find((s) => s.id === b1.shipId);

  // Crew both bots on the SAFE ship so nobody dies outside the ring (an
  // elimination would force-sink its home hull and poison the assertions).
  b0.shipId = safeShip.id;
  b0.onShipId = safeShip.id;
  b0.position = { ...b1.position };
  testShip.crewIds = [];
  safeShip.crewIds = [b1.id, b0.id];

  st.storm.centerX = 0;
  st.storm.centerZ = 0;
  st.storm.safeRadius = 300;
  st.storm.shrinking = false;
  st.storm.shrinkTimer = 99999;
  st.storm.damagePerSec = 90;

  // Open water outside the ring, far from every other hull so no bot wanders
  // into gunnery range and muddies the section pattern.
  const spot = findOpenSea(st, (x, z) => {
    const d = Math.hypot(x, z);
    if (d < 500 || d > 700) return false;
    return st.ships.every((s) => s.id === testShip.id
      || Math.hypot(x - s.position.x, z - s.position.z) > 450);
  });
  testShip.position = { x: spot.x, y: 0, z: spot.z };
  // Face dead away from the storm center so the seaward section is cleanly the
  // bow (a heading near a 45° boundary would smear the battering over two rails).
  testShip.rotation = Math.atan2(spot.x, spot.z);
  testShip.velocity = { x: 0, y: 0, z: 0 };
  testShip.angularVelocity = 0;
  testShip.anchored = true;
  testShip.inventory = testShip.inventory.filter((s) => s.item !== 'wood_plank');

  let ticks = 0;
  for (; ticks < 900; ticks++) {
    b0.health = 100;
    b1.health = 100;
    match.tick();
    if (countOpenHoles(testShip) >= 2) break;
  }
  const stormHoles = testShip.holes.filter((h) => !h.patched);
  const stormStats = SHIP_STATS[testShip.type];
  expect('the storm stoves real planking in', stormHoles.length >= 1,
    `holes=${JSON.stringify(testShip.holes)} after ${ticks} ticks`);
  expect('every sea breaks through the SEAWARD (bow) face',
    stormHoles.length > 0 && stormHoles.every((h) => holeFace(h, stormStats) === 'bow'),
    JSON.stringify(stormHoles.map((h) => [holeFace(h, stormStats), +h.x.toFixed(2), +h.z.toFixed(2)])));
  expect('breaking seas land in the waterline band, not at a fixed decal point',
    stormHoles.every((h) => h.y >= FLOODING.HOLE_BAND_Y.min && h.y <= FLOODING.HOLE_BAND_Y.max),
    JSON.stringify(stormHoles.map((h) => +h.y.toFixed(3))));
  expect('two seas do not break through the SAME plank (they spread along the face)',
    stormHoles.length < 2 || stormHoles.some((h) => Math.abs(h.x - stormHoles[0].x) > 0.05),
    JSON.stringify(stormHoles.map((h) => +h.x.toFixed(3))));
  expect('storm damage routes through openHoleAt (repair delay armed)',
    testShip.repairCooldown > 0, `repairCooldown=${testShip.repairCooldown}`);
  expect('the battered ship is still afloat (SoT fight, not silent deletion)',
    testShip.sinking === false && testShip.alive === true);

  // The punched hole must now flood like any cannonball hole. Bring the hull
  // back inside the calm ring first: out in the storm swell the pitching bow
  // only ships water on some passes, but at the static float line a hole
  // floods deterministically — proving the hole is REAL (holes + bailing
  // fight), not silent hp loss.
  const calmSpot = findOpenSea(st, (x, z) => {
    if (Math.hypot(x, z) > st.storm.safeRadius - 60) return false;
    return st.ships.every((s) => s.id === testShip.id
      || Math.hypot(x - s.position.x, z - s.position.z) > 260);
  });
  testShip.position = { x: calmSpot.x, y: 0, z: calmSpot.z };
  testShip.velocity = { x: 0, y: 0, z: 0 };
  // Drop the storm breaches to the waterline so they gush deterministically at
  // the static float line, proving the hole is REAL (holes + water), not hp loss.
  for (const h of testShip.holes) h.y = 0;
  const waterBefore = testShip.waterLevel ?? 0;
  for (let i = 0; i < 600; i++) {
    b0.health = 100;
    b1.health = 100;
    match.tick();
  }
  expect('the storm hole takes on water (flooding loop engaged)',
    (testShip.waterLevel ?? 0) > waterBefore + 0.008,
    `water ${waterBefore.toFixed(4)} → ${(testShip.waterLevel ?? 0).toFixed(4)}`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n8. ship_damage broadcasts reach every client (not just the attacker)');

{
  const match = new Match({ matchId: 'combat-broadcast', botCount: 2 });
  const st = match.state;
  const attacker = st.players[0];
  const victimShip = st.ships.find((s) => s.id !== attacker.shipId);

  const attackerMsgs = [];
  const bystanderMsgs = [];
  match.clients.set(attacker.id, { ws: makeFakeWs(attackerMsgs), playerId: attacker.id, lastInput: null });
  match.clients.set('bystander', { ws: makeFakeWs(bystanderMsgs), playerId: 'bystander', lastInput: null });

  const stats = SHIP_STATS[victimShip.type];
  match.physics.onProjectileHitShip(makeProjectile({
    ownerId: attacker.id,
    ownerShipId: attacker.shipId,
    position: {
      x: victimShip.position.x,
      y: victimShip.position.y + 1,
      z: victimShip.position.z + stats.length * 0.4,
    },
  }), victimShip, match.t);
  match.relayPendingCombatEvents();

  const bystanderDamage = bystanderMsgs.filter((m) => m.type === 'ship_damage');
  expect('bystanders receive the ship_damage broadcast', bystanderDamage.length === 1,
    `got ${bystanderMsgs.map((m) => m.type).join(',') || 'nothing'}`);
  const payload = bystanderDamage[0]?.payload;
  expect('broadcast carries target/section/impact point for decals',
    !!payload
    && payload.targetId === victimShip.id
    && typeof payload.section === 'string'
    && typeof payload.position?.x === 'number'
    && typeof payload.remainingSection === 'number',
    JSON.stringify(payload ?? null));
  expect('bystanders do NOT get the attacker-only hit confirm',
    bystanderMsgs.every((m) => m.type !== 'ship_hit'));
  expect('the attacker still gets the hit confirm',
    attackerMsgs.filter((m) => m.type === 'ship_hit').length === 1,
    attackerMsgs.map((m) => m.type).join(','));
  expect('the attacker also sees the world broadcast',
    attackerMsgs.filter((m) => m.type === 'ship_damage').length === 1);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n9. A keg blast clusters breaches on the face it was lashed to');

{
  const match = new Match({ matchId: 'combat-keg-holes', botCount: 2 });
  const st = match.state;
  st.phase = 'playing';
  const ship = st.ships[0];
  const stats = SHIP_STATS[ship.type];
  ship.holes = [];
  ship.nextHoleId = 1;
  ship.onFire = false;

  // Lash a keg to the starboard rail, well aft of amidships.
  const kegLocal = { x: stats.width * 0.4, z: -stats.length * 0.3 };
  const kegWorld = match.toShipWorld(kegLocal.x, kegLocal.z, ship);
  st.kegs.push({
    id: 'keg-test', shipId: ship.id, plantedById: st.players[0].id,
    section: 'starboard', position: { x: kegWorld.x, y: ship.position.y + stats.height, z: kegWorld.z },
    localPosition: { x: kegLocal.x, y: stats.height, z: kegLocal.z },
    timer: 0.001, mega: false,
  });
  match.updateKegs(1);

  const holes = ship.holes.filter((h) => !h.patched);
  const byFace = { bow: 0, stern: 0, port: 0, starboard: 0 };
  for (const h of holes) byFace[holeFace(h, stats)] += 1;
  expect('the blast breaches every face of the hull', 
    Object.values(byFace).every((n) => n > 0), JSON.stringify(byFace));
  expect('the face the barrel sat on is stove in hardest',
    byFace.starboard > byFace.port && byFace.starboard > byFace.bow,
    JSON.stringify(byFace));
  const primary = holes.filter((h) => holeFace(h, stats) === 'starboard');
  expect('primary-face breaches cluster within ~1.5 m of where the keg sat',
    primary.every((h) => Math.hypot(h.x - kegLocal.x, h.z - kegLocal.z) < 1.5),
    JSON.stringify(primary.map((h) => [+h.x.toFixed(2), +h.z.toFixed(2)])));
  expect('every keg breach rides the waterline band',
    holes.every((h) => h.y >= FLOODING.HOLE_BAND_Y.min && h.y <= FLOODING.HOLE_BAND_Y.max),
    JSON.stringify(holes.map((h) => +h.y.toFixed(3))));
  expect('the blast also sets her alight', ship.onFire === true);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n10. A saturated hull is NEVER immune (the old 3-per-section bug)');

{
  const physics = new PhysicsSystem();
  const ship = makeShip('sloop');
  const stats = SHIP_STATS.sloop;
  // Empty a whole broadside into one flank.
  for (let i = 0; i < FLOODING.MAX_HOLES_PER_SHIP + 6; i++) {
    physics.openHoleAt(ship, { x: stats.width * 0.5, y: 0.2, z: (i % 7) - 3 }, 1, 'cannon');
  }
  expect('the list never grows past MAX_HOLES_PER_SHIP',
    ship.holes.length === FLOODING.MAX_HOLES_PER_SHIP, `holes=${ship.holes.length}`);
  expect('a saturated flank keeps taking fire (all slots open, none swallowed)',
    countOpenHoles(ship) === FLOODING.MAX_HOLES_PER_SHIP);

  // Plank her up completely, then keep shooting: the plank comes off.
  for (const h of ship.holes) h.patched = true;
  expect('a fully planked hull leaks nothing', countOpenHoles(ship) === 0);
  physics.openHoleAt(ship, { x: stats.width * 0.5, y: 0.2, z: 0 }, 1, 'cannon');
  expect('a hit on a saturated, fully-patched hull RE-OPENS a breach',
    countOpenHoles(ship) === 1 && ship.holes.length === FLOODING.MAX_HOLES_PER_SHIP,
    `open=${countOpenHoles(ship)} total=${ship.holes.length}`);
  expect('the re-opened breach moved to where the new ball struck',
    ship.holes.some((h) => !h.patched && Math.abs(h.z) < 0.01),
    JSON.stringify(ship.holes.filter((h) => !h.patched)));

  // Charged cannons still add their extra hole; a super shot still caves in 3.
  const charged = makeShip('sloop');
  physics.onProjectileHitShip(makeProjectile({
    position: { x: 2, y: charged.position.y + 0.2, z: 0 },
    damage: SHIP.CANNON_DAMAGE_HULL * 1.5,
  }), charged, 0);
  expect('charged_cannons still punch more than one breach', charged.holes.length > 1,
    `holes=${charged.holes.length}`);
  const superShip = makeShip('sloop');
  const superProj = makeProjectile({ position: { x: 2, y: superShip.position.y + 0.2, z: 0 } });
  superProj.special = 'super_cannonball';
  physics.onProjectileHitShip(superProj, superShip, 0);
  expect('a super cannonball caves in three', superShip.holes.length === 3,
    `holes=${superShip.holes.length}`);
  expect('sibling breaches scatter instead of stacking on one point',
    new Set(superShip.holes.map((h) => `${h.x.toFixed(2)},${h.z.toFixed(2)}`)).size === 3,
    JSON.stringify(superShip.holes.map((h) => [+h.x.toFixed(2), +h.z.toFixed(2)])));
  physics.flushCombatEvents();
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n11. The hole list fits the wire, even with every hull at the cap');

{
  const match = new Match({ matchId: 'combat-hole-wire', botCount: 9 });
  for (let i = 0; i < 250; i++) match.tick(1 / 62.5);
  const clean = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false)).length;

  // Worst case the protocol can ever see: every alive hull carrying its full
  // MAX_HOLES_PER_SHIP, and every one of them PATCHED (the longest encoding).
  for (const ship of match.state.ships) {
    ship.holes = [];
    ship.nextHoleId = 1;
    match.physics.openHoleAt(ship, { x: 2.4, y: 0.15, z: 0 }, FLOODING.MAX_HOLES_PER_SHIP, 'cannon');
  }
  const riddled = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false));
  for (const ship of match.state.ships) for (const h of ship.holes) h.patched = true;
  const planked = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false));
  const hot = JSON.stringify(buildHotSnapshot(match.state, match.t));
  const totalHoles = match.state.ships.reduce((n, s) => n + s.holes.length, 0);
  console.log(`  sizes: clean=${(clean / 1024).toFixed(1)}KB riddled=${(riddled.length / 1024).toFixed(1)}KB planked=${(planked.length / 1024).toFixed(1)}KB (${totalHoles} holes) hot=${(hot.length / 1024).toFixed(1)}KB`);

  expect('every hull at the cap still fits the 35KB full-snapshot guard',
    riddled.length < 35 * 1024, `${riddled.length}B`);
  expect('...and so does the pricier all-planked encoding',
    planked.length < 35 * 1024, `${planked.length}B`);
  expect('the hole list is what grew, and it is small',
    riddled.length > clean && riddled.length - clean < 4 * 1024,
    `+${riddled.length - clean}B for ${totalHoles} holes`);
  expect('breaches do NOT ride the 31Hz hot channel (ship_damage covers latency)',
    !hot.includes('"holes"') && hot.length < 8 * 1024, `${hot.length}B`);
  expect('the server-internal hole counter never ships', !riddled.includes('nextHoleId'));
  expect('the retired per-section hull bars are gone from the wire',
    !/"hull":\{/.test(riddled));
  expect('an open breach ships id + point and nothing else',
    /\{"id":\d+,"x":-?[\d.]+,"y":-?[\d.]+,"z":-?[\d.]+\}/.test(riddled));
}

if (failures > 0) {
  console.error(`\n${failures} combat-fix assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll combat-fix assertions passed.');
