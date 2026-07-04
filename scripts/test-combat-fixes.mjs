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
//   7. storm hull damage routes through damageHullSection → holes + flooding
//   8. ship_damage broadcasts reach every client, not just the attacker
import { PhysicsSystem, updateShipFlooding, evaluateSectionFlood } from '../src/server/systems/PhysicsSystem.ts';
import { WeaponSystem } from '../src/server/systems/WeaponSystem.ts';
import { Match } from '../src/server/core/Match.ts';
import { SHIP, SHIP_STATS, FLOODING, PLAYER } from '../src/shared/constants/index.ts';
import { gerstnerHeight, WAVE_PARAMS } from '../src/shared/utils/index.ts';

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
    hull: { bow: 1, stern: 1, port: 1, starboard: 1 },
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

function makeBailInput() {
  return {
    seq: 1, ts: 0,
    forward: false, back: false, left: false, right: false,
    jump: false, jumpPressed: false, fire: false, aim: false,
    interact: false, interactHeld: true,
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
  expect('the waterline shot holes the hull section (starboard)',
    ship.hull.starboard < 1, `hull=${JSON.stringify(ship.hull)}`);
  const events = physics.flushCombatEvents();
  const hit = events.find((e) => e.type === 'ship_hit');
  expect('ship_hit event emitted for the waterline shot',
    !!hit && hit.targetId === ship.id && hit.section === 'starboard',
    JSON.stringify(events));

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
  expect('chainshot opens NO hull holes',
    ship.hull.bow === 1 && ship.hull.stern === 1 && ship.hull.port === 1 && ship.hull.starboard === 1,
    JSON.stringify(ship.hull));
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
  expect('...leaving the hull untouched',
    ship2.hull.bow === 1 && ship2.hull.stern === 1 && ship2.hull.port === 1 && ship2.hull.starboard === 1);
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
  shipB.hull = { bow: 1, stern: 1, port: 0.06, starboard: 0.06 };
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
  expect('the ram itself broke a hull section',
    Math.min(shipB.hull.bow, shipB.hull.stern, shipB.hull.port, shipB.hull.starboard) <= 0,
    JSON.stringify(shipB.hull));

  const killsBefore = attacker.kills;
  const goldBefore = attacker.gold;
  // Holes, not hp, decide: the ram breached the hull, so the water finishes
  // the job — run the flood forward to the founder (well under a minute for
  // a wrecked section set) and then assert the credited sink.
  let ramFloodT = 0;
  for (let i = 0; i < 90 * 62 && shipB.sinking !== true; i++) {
    updateShipFlooding(shipB, match.t, DT);
    match.evaluateShipSinking(shipB);
    ramFloodT += DT;
  }
  expect('the rammed ship sinks (via the water pouring through the ram breach)',
    shipB.sinking === true, `flooded ${ramFloodT.toFixed(1)}s`);
  expect('the rammed crew is eliminated (credited sink, no swim-away)',
    victimCrew.every((p) => p.state === 'eliminated'),
    victimCrew.map((p) => p.state).join(','));
  expect('rammer banks the kill(s)', attacker.kills === killsBefore + victimCrew.length,
    `kills=${attacker.kills}`);
  expect('rammer banks the kill gold', attacker.gold >= goldBefore + PLAYER.KILL_GOLD_REWARD * victimCrew.length,
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

  // Park in open water inside a pinned storm ring, one holed section, no
  // auto-repair planks — one bailer (0.014/s) beats one hole (0.010/s).
  const spot = findOpenSea(st, (x, z) => Math.hypot(x, z) < 700);
  ship.position = { x: spot.x, y: 0, z: spot.z };
  ship.velocity = { x: 0, y: 0, z: 0 };
  ship.anchored = true;
  ship.inventory = ship.inventory.filter((s) => s.item !== 'wood_plank');
  ship.hull.port = 0.3;
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
  const levelBeforeControl = ship.waterLevel;
  for (let i = 0; i < 30; i++) { player.health = 100; if (bot) bot.health = 100; match.tick(); }
  expect('untended hole: replicated floodingRate is positive',
    ship.floodingRate > 0.005, `rate=${ship.floodingRate}`);
  expect('untended hole: water actually rises', ship.waterLevel > levelBeforeControl + 0.0015,
    `water ${levelBeforeControl.toFixed(4)} → ${ship.waterLevel.toFixed(4)}`);

  // One bailer via the real input path: bail (0.014) beats ingress (0.010),
  // so the NET trend the client sees must go negative even though the hole
  // is still open (the old code published raw ingress = inverted feedback).
  const client = match.clients.get(joined.playerId);
  client.lastInput = makeBailInput();
  const levelBeforeBail = ship.waterLevel;
  for (let i = 0; i < 30; i++) { player.health = 100; if (bot) bot.health = 100; match.tick(); }
  expect('bailer is recognized (player.bailing set)', player.bailing === true);
  expect('winning bailer: replicated floodingRate goes NEGATIVE',
    ship.floodingRate < -0.001, `rate=${ship.floodingRate}`);
  expect('winning bailer: water actually falls', ship.waterLevel < levelBeforeBail - 0.001,
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

  const sections = ['bow', 'stern', 'port', 'starboard'];
  let ticks = 0;
  for (; ticks < 900; ticks++) {
    b0.health = 100;
    b1.health = 100;
    match.tick();
    if (Math.min(...sections.map((s) => testShip.hull[s])) <= 0.45) break;
  }
  const hull = sections.map((s) => testShip.hull[s]).sort((a, b) => a - b);
  expect('the storm holes a hull section (≤ hole threshold)',
    hull[0] <= FLOODING.HOLE_THRESHOLD, `hull=${JSON.stringify(testShip.hull)} after ${ticks} ticks`);
  expect('the seaward (bow) face takes the brunt',
    testShip.hull.bow === hull[0], `hull=${JSON.stringify(testShip.hull)}`);
  expect('damage is per-section (seaward face battered, rest glancing) — not lockstep melt',
    hull[1] > 0.8, `hull=${JSON.stringify(testShip.hull)}`);
  expect('storm damage routes through damageHullSection (repair delay armed)',
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

if (failures > 0) {
  console.error(`\n${failures} combat-fix assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll combat-fix assertions passed.');
